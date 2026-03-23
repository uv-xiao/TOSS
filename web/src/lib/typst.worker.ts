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
    const vector = await typst.vector({ mainFilePath });
    const pdf = await typst.pdf({ mainFilePath });
    compileCount += 1;
    if (compileCount > 40) {
      resetCompilerState();
    }
    self.postMessage({
      id,
      ok: !!vector,
      vectorBytes: vector,
      pdfBytes: pdf,
      errors: []
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
