import type { CompileDiagnostic } from "./typst";

type CompileRequest = {
  id: number;
  entryFilePath: string;
  documents: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; content_base64: string }>;
  coreApiUrl: string;
  appOrigin?: string;
  engine: "pdftex" | "xetex";
};

type CompileResponse = {
  id: number;
  ok: boolean;
  pdfBytes?: Uint8Array;
  errors?: string[];
  diagnostics?: CompileDiagnostic[];
};

type RuntimeStatusMessage = {
  kind: "runtime.status";
  stage: "downloading-compiler" | "compiling" | "ready" | "idle";
  loaded_bytes?: number;
  total_bytes?: number;
};

type SwiftCommandResponse = {
  cmd?: string;
  result?: string;
  status?: number;
  log?: string;
  pdf?: ArrayBuffer;
};

type PendingCommand = {
  match: (data: SwiftCommandResponse) => boolean;
  resolve: (data: SwiftCommandResponse) => void;
  reject: (error: Error) => void;
  timeout: number;
};

type CompilerBootstrapAsset = {
  url: string;
  format: number;
  filename: string;
};

class SwiftLatexSession {
  private worker: Worker;
  private ready = false;
  private pending: PendingCommand[] = [];

  constructor(workerUrl: string) {
    this.worker = new Worker(workerUrl);
    this.worker.onmessage = (event: MessageEvent<SwiftCommandResponse>) => {
      const data = event.data || {};
      const index = this.pending.findIndex((pending) => pending.match(data));
      if (index >= 0) {
        const item = this.pending[index];
        this.pending.splice(index, 1);
        clearTimeout(item.timeout);
        item.resolve(data);
      }
      if (data.result === "ok" && !data.cmd) {
        this.ready = true;
      }
    };
    this.worker.onerror = (event) => {
      const message =
        event && "message" in event && typeof event.message === "string"
          ? event.message
          : "SwiftLaTeX worker crashed";
      const error = new Error(message);
      const items = this.pending.splice(0, this.pending.length);
      for (const item of items) {
        clearTimeout(item.timeout);
        item.reject(error);
      }
      this.ready = false;
    };
  }

  async waitReady() {
    if (this.ready) return;
    await this.waitFor((data) => data.result === "ok" && !data.cmd, 120000);
    this.ready = true;
  }

  postMessage(message: Record<string, unknown>) {
    this.worker.postMessage(message);
  }

  async waitFor(
    match: (data: SwiftCommandResponse) => boolean,
    timeoutMs: number
  ): Promise<SwiftCommandResponse> {
    return new Promise<SwiftCommandResponse>((resolve, reject) => {
      const timeout = self.setTimeout(() => {
        this.pending = this.pending.filter((item) => item !== entry);
        reject(new Error("SwiftLaTeX command timeout"));
      }, timeoutMs);
      const entry: PendingCommand = {
        match,
        resolve,
        reject,
        timeout
      };
      this.pending.push(entry);
    });
  }

  close() {
    this.worker.terminate();
    this.pending = [];
    this.ready = false;
  }
}

const sessions = new Map<string, SwiftLatexSession>();
let compileQueue: Promise<void> = Promise.resolve();
const bootstrapPrepared = new Set<string>();
const bootstrapAssetBytes = new Map<string, Uint8Array>();
const BOOTSTRAP_CACHE_NAME = "swiftlatex-bootstrap-v1";

function normalizeWorkspacePath(path: string, fallback: string) {
  const clean = path.trim().replace(/^\/+/, "");
  if (!clean) return fallback;
  return clean;
}

function memfsWorkPath(path: string) {
  const clean = path.trim().replace(/^\/+/, "");
  return `/work/${clean}`;
}

function ensureParentDirectories(path: string, allDirs: Set<string>) {
  const parts = normalizeWorkspacePath(path, "").split("/").filter(Boolean);
  if (parts.length <= 1) return;
  let current = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    allDirs.add(current);
  }
}

function base64ToUint8(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function texliveEndpoint(coreApiUrl: string, appOrigin: string) {
  const base = coreApiUrl.replace(/\/$/, "") || appOrigin;
  return `${base.replace(/\/$/, "")}/v1/latex/texlive/`;
}

function compilerBootstrapUrls(engine: "pdftex" | "xetex", coreApiUrl: string, appOrigin: string) {
  const base = texliveEndpoint(coreApiUrl, appOrigin);
  if (engine === "pdftex") {
    return [
      { url: `${base}pdftex/10/swiftlatexpdftex.fmt`, format: 10, filename: "swiftlatexpdftex.fmt" },
      { url: `${base}pdftex/26/l3backend-pdfmode.def`, format: 26, filename: "l3backend-pdfmode.def" }
    ];
  }
  return [
    { url: `${base}xetex/10/swiftlatexxetex.fmt`, format: 10, filename: "swiftlatexxetex.fmt" },
    { url: `${base}xetex/10/xetexfontlist.txt`, format: 10, filename: "xetexfontlist.txt" },
    { url: `${base}xetex/26/l3backend-xdvipdfmx.def`, format: 26, filename: "l3backend-xdvipdfmx.def" }
  ];
}

function emitBootstrapProgress(loadedBytes: number, totalBytes: number) {
  self.postMessage({
    kind: "runtime.status",
    stage: "downloading-compiler",
    loaded_bytes: Math.max(0, loadedBytes),
    total_bytes: Math.max(1, totalBytes)
  } satisfies RuntimeStatusMessage);
}

async function downloadBytesWithXhrProgress(
  url: string,
  onProgress: (loadedBytes: number, totalBytes: number | null) => void
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.withCredentials = true;
    xhr.onprogress = (event) => {
      const nextLoaded = Math.max(0, event.loaded || 0);
      const nextTotal = event.lengthComputable && event.total > 0 ? event.total : null;
      onProgress(nextLoaded, nextTotal);
    };
    xhr.onerror = () => reject(new Error(`Failed to download compiler asset: ${url}`));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Compiler asset download failed (${xhr.status}): ${url}`));
        return;
      }
      const response = xhr.response as ArrayBuffer | null;
      if (!response) {
        reject(new Error(`Empty compiler asset response: ${url}`));
        return;
      }
      const bytes = new Uint8Array(response);
      const totalHeader = Number.parseInt(xhr.getResponseHeader("content-length") || "0", 10);
      const totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : bytes.byteLength;
      onProgress(bytes.byteLength, totalBytes);
      resolve(bytes);
    };
    xhr.send();
  });
}

async function readResponseBytesWithProgress(
  response: Response,
  onChunk: (chunkBytes: number) => void
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onChunk(bytes.byteLength);
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    chunks.push(value);
    total += value.byteLength;
    onChunk(value.byteLength);
  }
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function ensureCompilerBootstrapCached(
  engine: "pdftex" | "xetex",
  coreApiUrl: string,
  appOrigin: string
) {
  const cacheKey = `${engine}:${texliveEndpoint(coreApiUrl, appOrigin)}`;
  if (bootstrapPrepared.has(cacheKey)) return;
  const urls = compilerBootstrapUrls(engine, coreApiUrl, appOrigin);
  const cacheStorage = typeof caches !== "undefined" ? await caches.open(BOOTSTRAP_CACHE_NAME) : null;
  let loadedBytes = 0;
  let totalBytes = 0;
  emitBootstrapProgress(0, 1);
  for (const asset of urls) {
    let assetLoadedBytes = 0;
    let assetTotalBytes = 0;
    const reportAssetProgress = (nextLoaded: number, nextTotal: number | null) => {
      const safeLoaded = Number.isFinite(nextLoaded) ? Math.max(0, nextLoaded) : 0;
      if (safeLoaded > assetLoadedBytes) {
        loadedBytes += safeLoaded - assetLoadedBytes;
        assetLoadedBytes = safeLoaded;
      }
      if (nextTotal && Number.isFinite(nextTotal) && nextTotal > 0) {
        const safeTotal = Math.max(1, nextTotal);
        if (assetTotalBytes === 0) {
          totalBytes += safeTotal;
        } else if (assetTotalBytes !== safeTotal) {
          totalBytes += safeTotal - assetTotalBytes;
        }
        assetTotalBytes = safeTotal;
      }
      emitBootstrapProgress(loadedBytes, totalBytes > 0 ? totalBytes : loadedBytes || 1);
    };
    try {
      let response = cacheStorage ? await cacheStorage.match(asset.url) : undefined;
      if (response?.ok) {
        const headerTotal = Number.parseInt(response.headers.get("content-length") || "0", 10);
        reportAssetProgress(0, Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : null);
        const bytes = await readResponseBytesWithProgress(response, (chunkBytes) => {
          reportAssetProgress(assetLoadedBytes + chunkBytes, assetTotalBytes || null);
        });
        reportAssetProgress(bytes.byteLength, assetTotalBytes > 0 ? assetTotalBytes : bytes.byteLength);
        bootstrapAssetBytes.set(asset.url, bytes);
      } else {
        const bytes = await downloadBytesWithXhrProgress(asset.url, reportAssetProgress);
        bootstrapAssetBytes.set(asset.url, bytes);
        if (cacheStorage) {
          const body = new Uint8Array(bytes.byteLength);
          body.set(bytes);
          await cacheStorage.put(asset.url, new Response(body.buffer, { status: 200 }));
        }
      }
    } catch {
      // Best effort warmup. SwiftLaTeX runtime will retry as needed.
    }
  }
  emitBootstrapProgress(totalBytes > 0 ? totalBytes : loadedBytes, totalBytes > 0 ? totalBytes : loadedBytes || 1);
  bootstrapPrepared.add(cacheKey);
}

async function primeSessionBootstrapCache(
  session: SwiftLatexSession,
  engine: "pdftex" | "xetex",
  coreApiUrl: string,
  appOrigin: string
) {
  const assets = compilerBootstrapUrls(engine, coreApiUrl, appOrigin);
  for (const asset of assets) {
    const bytes = bootstrapAssetBytes.get(asset.url);
    if (!bytes || bytes.length === 0) continue;
    await sendAndWait(
      session,
      {
        cmd: "primecache",
        format: asset.format,
        filename: asset.filename,
        fileid: asset.filename,
        src: bytes
      },
      (data) => data.cmd === "primecache",
      30000
    ).catch(() => null);
  }
}

function swiftWorkerUrl(engine: "pdftex" | "xetex", appOrigin: string) {
  if (engine === "pdftex") {
    return new URL("/swiftlatex/texlyrepdftex.js", appOrigin).toString();
  }
  return new URL("/swiftlatex/texlyrexetex.js", appOrigin).toString();
}

function dvipdfmxWorkerUrl(appOrigin: string) {
  return new URL("/swiftlatex/texlyredvipdfm.js", appOrigin).toString();
}

function parseCompileDiagnostics(log: string): CompileDiagnostic[] {
  const lines = log.split(/\r?\n/);
  const diagnostics: CompileDiagnostic[] = [];
  const pattern =
    /^(?<path>[^:\r\n]+?\.(?:tex|ltx|sty|cls|bib)):(?<line>\d+):\s*(?<message>.+)$/i;
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    const match = raw.match(pattern);
    if (match?.groups) {
      diagnostics.push({
        severity: "error",
        path: match.groups.path.replace(/^\.\/+/, ""),
        line: Number.parseInt(match.groups.line, 10),
        column: 1,
        message: match.groups.message.trim(),
        raw
      });
      continue;
    }
    if (/^!/.test(raw) || /error/i.test(raw)) {
      diagnostics.push({
        severity: "error",
        message: raw.replace(/^!\s*/, ""),
        raw
      });
    }
  }
  return diagnostics;
}

function summarizeCompileErrors(log: string) {
  const lines = log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !!line);
  if (lines.length === 0) return ["LaTeX compile failed"];
  return lines.slice(-8);
}

async function ensureSession(engine: "pdftex" | "xetex", appOrigin: string) {
  const key = `${engine}:${appOrigin}`;
  let session = sessions.get(key);
  if (!session) {
    session = new SwiftLatexSession(swiftWorkerUrl(engine, appOrigin));
    sessions.set(key, session);
  }
  await session.waitReady();
  return session;
}

async function ensureDvipdfmxSession(appOrigin: string) {
  const key = `dvipdfmx:${appOrigin}`;
  let session = sessions.get(key);
  if (!session) {
    session = new SwiftLatexSession(dvipdfmxWorkerUrl(appOrigin));
    sessions.set(key, session);
  }
  await session.waitReady();
  return session;
}

async function sendAndWait(
  session: SwiftLatexSession,
  message: Record<string, unknown>,
  match: (data: SwiftCommandResponse) => boolean,
  timeoutMs = 20000
) {
  const pending = session.waitFor(match, timeoutMs);
  session.postMessage(message);
  return pending;
}

async function convertXdvToPdf(
  xdvBytes: ArrayBuffer,
  entryFilePath: string,
  coreApiUrl: string,
  appOrigin: string
): Promise<SwiftCommandResponse> {
  const session = await ensureDvipdfmxSession(appOrigin);
  session.postMessage({
    cmd: "settexliveurl",
    url: texliveEndpoint(coreApiUrl, appOrigin)
  });
  const xdvPath = normalizeWorkspacePath(entryFilePath, "main.tex").replace(/\.(tex|ltx)$/i, ".xdv");
  const allDirs = new Set<string>();
  ensureParentDirectories(xdvPath, allDirs);
  const sortedDirs = Array.from(allDirs).sort((a, b) => a.localeCompare(b));
  for (const dir of sortedDirs) {
    await sendAndWait(
      session,
      { cmd: "mkdir", url: dir },
      (data) => data.cmd === "mkdir",
      10000
    ).catch(() => null);
  }
  await sendAndWait(
    session,
    { cmd: "writefile", url: memfsWorkPath(xdvPath), src: new Uint8Array(xdvBytes) },
    (data) => data.cmd === "writefile",
    20000
  );
  session.postMessage({ cmd: "setmainfile", url: xdvPath });
  return sendAndWait(
    session,
    { cmd: "compilepdf" },
    (data) => data.cmd === "compile",
    120000
  );
}

async function compileWithSwiftLatex(request: CompileRequest): Promise<CompileResponse> {
  const appOrigin = request.appOrigin ?? self.location.origin;
  const entryFallback = request.engine === "pdftex" || request.engine === "xetex" ? "main.tex" : "main.typ";
  const entryFilePath = normalizeWorkspacePath(request.entryFilePath, entryFallback);
  self.postMessage({
    kind: "runtime.status",
    stage: "downloading-compiler"
  } satisfies RuntimeStatusMessage);
  await ensureCompilerBootstrapCached(request.engine, request.coreApiUrl, appOrigin);
  const session = await ensureSession(request.engine, appOrigin);
  session.postMessage({
    cmd: "settexliveurl",
    url: texliveEndpoint(request.coreApiUrl, appOrigin)
  });
  await primeSessionBootstrapCache(session, request.engine, request.coreApiUrl, appOrigin);
  self.postMessage({
    kind: "runtime.status",
    stage: "compiling"
  } satisfies RuntimeStatusMessage);

  const allDirs = new Set<string>();
  ensureParentDirectories(entryFilePath, allDirs);
  for (const doc of request.documents) {
    ensureParentDirectories(doc.path, allDirs);
  }
  for (const asset of request.assets) {
    ensureParentDirectories(asset.path, allDirs);
  }
  const sortedDirs = Array.from(allDirs).sort((a, b) => a.localeCompare(b));
  for (const dir of sortedDirs) {
    const response = await sendAndWait(
      session,
      { cmd: "mkdir", url: dir },
      (data) => data.cmd === "mkdir",
      10000
    ).catch(() => null);
    const failed = response?.result === "failed";
    if (failed) {
      // Existing directories are expected to return "failed" from this worker.
      continue;
    }
  }
  for (const doc of request.documents) {
    const path = normalizeWorkspacePath(doc.path, "");
    await sendAndWait(
      session,
      { cmd: "writefile", url: memfsWorkPath(path), src: doc.content },
      (data) => data.cmd === "writefile",
      20000
    );
  }
  for (const asset of request.assets) {
    const path = normalizeWorkspacePath(asset.path, "");
    await sendAndWait(
      session,
      { cmd: "writefile", url: memfsWorkPath(path), src: base64ToUint8(asset.content_base64) },
      (data) => data.cmd === "writefile",
      20000
    );
  }
  session.postMessage({ cmd: "setmainfile", url: entryFilePath });

  let compileResult: SwiftCommandResponse | null = null;
  for (let pass = 0; pass < 3; pass += 1) {
    compileResult = await sendAndWait(
      session,
      { cmd: "compilelatex" },
      (data) => data.cmd === "compile",
      120000
    );
    if (compileResult.status !== 0) break;
  }
  const status = compileResult?.status ?? -1;
  const log = compileResult?.log || "";
  if (status === 0 && compileResult?.result === "ok" && compileResult.pdf) {
    let pdfBytes: Uint8Array;
    if (request.engine === "xetex") {
      const dvipdfResult = await convertXdvToPdf(
        compileResult.pdf,
        entryFilePath,
        request.coreApiUrl,
        appOrigin
      );
      if (!(dvipdfResult.status === 0 && dvipdfResult.result === "ok" && dvipdfResult.pdf)) {
        const log = dvipdfResult.log?.trim() || "DVI to PDF conversion failed";
        return {
          id: request.id,
          ok: false,
          errors: summarizeCompileErrors(log),
          diagnostics: parseCompileDiagnostics(log)
        };
      }
      pdfBytes = new Uint8Array(dvipdfResult.pdf);
    } else {
      pdfBytes = new Uint8Array(compileResult.pdf);
    }
    return {
      id: request.id,
      ok: true,
      pdfBytes,
      errors: [],
      diagnostics: []
    };
  }
  const diagnostics = parseCompileDiagnostics(log);
  return {
    id: request.id,
    ok: false,
    errors: diagnostics.length > 0 ? diagnostics.map((item) => item.raw) : summarizeCompileErrors(log),
    diagnostics
  };
}

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const request = event.data;
  compileQueue = compileQueue
    .then(() => handleCompile(request))
    .catch(() => handleCompile(request));
};

async function handleCompile(request: CompileRequest) {
  try {
    const response = await compileWithSwiftLatex(request);
    self.postMessage(response);
    self.postMessage({
      kind: "runtime.status",
      stage: "ready"
    } satisfies RuntimeStatusMessage);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "LaTeX compile failed";
    self.postMessage({
      id: request.id,
      ok: false,
      errors: [message],
      diagnostics: []
    } satisfies CompileResponse);
    self.postMessage({
      kind: "runtime.status",
      stage: "idle"
    } satisfies RuntimeStatusMessage);
  }
}
