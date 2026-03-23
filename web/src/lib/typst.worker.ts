import { TypstSnippet } from "@myriaddreamin/typst.ts/contrib/snippet";
import { FetchAccessModel } from "@myriaddreamin/typst.ts/fs/fetch";
import { FetchPackageRegistry } from "@myriaddreamin/typst.ts/fs/package";
import {
  disableDefaultFontAssets,
  loadFonts,
  withAccessModel,
  withPackageRegistry
} from "@myriaddreamin/typst.ts/options.init";

type CompileRequest = {
  id: number;
  entryFilePath: string;
  documents: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; content_base64: string }>;
  coreApiUrl: string;
  fontData: Uint8Array[];
  appOrigin?: string;
};

type CompileResponse = {
  id: number;
  ok: boolean;
  vectorBytes?: Uint8Array;
  pdfBytes?: Uint8Array;
  errors?: string[];
  diagnostics?: CompileDiagnostic[];
};

type CompileDiagnostic = {
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
  line?: number;
  column?: number;
  raw: string;
};

class NormalizedFetchAccessModel extends FetchAccessModel {
  resolvePath(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return super.resolvePath(normalized);
  }
}

let typstPromise: Promise<TypstSnippet> | null = null;
let accessModel: NormalizedFetchAccessModel | null = null;
let configKey = "";
let compileCount = 0;

function resetCompilerState() {
  typstPromise = null;
  accessModel = null;
  configKey = "";
  compileCount = 0;
}

function compilerWasmUrl(appOrigin: string) {
  return new URL("/typst-wasm/typst_ts_web_compiler_bg.wasm", appOrigin).toString();
}

function packageProxyBase(coreApiUrl: string, appOrigin: string) {
  const base = coreApiUrl.replace(/\/$/, "") || appOrigin;
  return `${base.replace(/\/$/, "")}/v1/typst/packages`;
}

function normalizeWorkspacePath(path: string) {
  const clean = path.trim().replace(/^\/+/, "");
  if (!clean) return "main.typ";
  return clean;
}

function sourcePath(path: string) {
  return `/${normalizeWorkspacePath(path)}`;
}

function parseCompileDiagnostic(rawLine: string): CompileDiagnostic {
  const raw = rawLine.trim();
  const pattern =
    /^(?<path>.+?):(?<line>\d+):(?<column>\d+)(?::\d+:\d+)?:\s*(?<severity>error|warning|info):\s*(?<message>.+)$/i;
  const matched = raw.match(pattern);
  if (!matched?.groups) {
    return {
      severity: "error",
      message: raw,
      raw
    };
  }
  const path = matched.groups.path.replace(/^\/+/, "");
  const line = Number.parseInt(matched.groups.line, 10);
  const column = Number.parseInt(matched.groups.column, 10);
  const severityRaw = matched.groups.severity.toLowerCase();
  const severity: "error" | "warning" | "info" =
    severityRaw === "warning" ? "warning" : severityRaw === "info" ? "info" : "error";
  return {
    severity,
    path: path || undefined,
    line: Number.isFinite(line) ? line : undefined,
    column: Number.isFinite(column) ? column : undefined,
    message: matched.groups.message.trim(),
    raw
  };
}

function base64ToUint8(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function fetchArrayBufferWithContext(url: string, label: string) {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    throw new Error(`${label} fetch failed at ${url}: ${message}`);
  }
  if (!response.ok) {
    throw new Error(`${label} fetch failed at ${url}: status ${response.status}`);
  }
  return response.arrayBuffer();
}

async function getTypst(coreApiUrl: string, fontData: Uint8Array[], appOrigin: string) {
  const packageBase = packageProxyBase(coreApiUrl, appOrigin);
  const nextKey = JSON.stringify({
    packageBase,
    appOrigin,
    fontCount: fontData.length,
    fontSizes: fontData.map((f) => f.byteLength)
  });
  if (!typstPromise || !accessModel || configKey !== nextKey) {
    configKey = nextKey;
    compileCount = 0;
    accessModel = new NormalizedFetchAccessModel(packageBase, { fullyCached: true });
    typstPromise = (async () => {
      const typst = new TypstSnippet();
      typst.setCompilerInitOptions({
        beforeBuild: [
          withAccessModel(accessModel!),
          withPackageRegistry(new FetchPackageRegistry(accessModel!)),
          disableDefaultFontAssets(),
          loadFonts(fontData)
        ],
        getModule: async () =>
          fetchArrayBufferWithContext(compilerWasmUrl(appOrigin), "compiler wasm")
      });
      return typst;
    })();
  }
  return typstPromise;
}

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const request = event.data;
  compileQueue = compileQueue
    .then(() => handleCompile(request))
    .catch(() => handleCompile(request));
};

let compileQueue: Promise<void> = Promise.resolve();

async function handleCompile(eventData: CompileRequest) {
  const { id, documents, assets, coreApiUrl, fontData } = eventData;
  const appOrigin = eventData.appOrigin ?? self.location.origin;
  const entryFilePath = normalizeWorkspacePath(eventData.entryFilePath || "main.typ");
  try {
    const typst = await getTypst(coreApiUrl, fontData, appOrigin);
    if (!accessModel) throw new Error("Compiler access model missing");
    await typst.resetShadow();
    for (const document of documents) {
      const abs = sourcePath(document.path);
      const rel = normalizeWorkspacePath(document.path);
      await typst.addSource(abs, document.content);
      await typst.addSource(rel, document.content);
    }
    for (const asset of assets) {
      const abs = sourcePath(asset.path);
      const rel = normalizeWorkspacePath(asset.path);
      const bytes = base64ToUint8(asset.content_base64);
      await typst.mapShadow(abs, bytes);
      await typst.mapShadow(rel, bytes);
    }
    const mainFilePath = sourcePath(entryFilePath);
    const compiler = await typst.getCompiler();
    const worldResult = await compiler.runWithWorld({ mainFilePath }, async (world) => {
      const check = await world.compile({ diagnostics: "unix" });
      const checkDiagnostics = (check.diagnostics || []).map((item) => String(item).trim()).filter((item) => !!item);
      if (check.hasError) {
        return {
          vector: undefined,
          pdf: undefined,
          diagnostics: checkDiagnostics
        };
      }
      const vectorResult = await world.vector({ diagnostics: "unix" });
      const pdfResult = await world.pdf({ diagnostics: "none" });
      const vectorDiagnostics = (vectorResult.diagnostics || [])
        .map((item) => String(item).trim())
        .filter((item) => !!item);
      return {
        vector: vectorResult.result,
        pdf: pdfResult.result,
        diagnostics: vectorDiagnostics.length > 0 ? vectorDiagnostics : checkDiagnostics
      };
    });
    const vector = worldResult.vector;
    const pdf = worldResult.pdf;
    const diagnostics = (worldResult.diagnostics || [])
      .map((item) => String(item).trim())
      .filter((item) => !!item)
      .map((item) => parseCompileDiagnostic(item));
    const errorDiagnostics = diagnostics.filter((item) => item.severity === "error");
    compileCount += 1;
    if (compileCount > 40) {
      resetCompilerState();
    }
    self.postMessage({
      id,
      ok: !!vector,
      vectorBytes: vector,
      pdfBytes: pdf,
      errors:
        errorDiagnostics.length > 0
          ? errorDiagnostics.map((item) => item.raw)
          : diagnostics.map((item) => item.raw),
      diagnostics
    } satisfies CompileResponse);
    return;
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : JSON.stringify(err);
    self.postMessage({
      id,
      ok: false,
      errors: [message || "Typst compile failed"]
    } satisfies CompileResponse);
    if (/memory access out of bounds|unreachable|RuntimeError/i.test(message)) {
      resetCompilerState();
    }
  }
}
