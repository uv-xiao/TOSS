import {
  TypstSnippet
} from "@myriaddreamin/typst.ts/contrib/snippet";
import { FetchAccessModel } from "@myriaddreamin/typst.ts/fs/fetch";
import { FetchPackageRegistry } from "@myriaddreamin/typst.ts/fs/package";
import { disableDefaultFontAssets, loadFonts } from "@myriaddreamin/typst.ts/options.init";
import { withAccessModel, withPackageRegistry } from "@myriaddreamin/typst.ts/options.init";

type CompileRequest = {
  id: number;
  source: string;
  coreApiUrl: string;
  fontData: Uint8Array[];
  appOrigin?: string;
};

type CompileResponse = {
  id: number;
  ok: boolean;
  vectorBytes?: Uint8Array;
  errors?: string[];
};

class NormalizedFetchAccessModel extends FetchAccessModel {
  resolvePath(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return super.resolvePath(normalized);
  }
}

let typstPromise: Promise<TypstSnippet> | null = null;
let localTypstPromise: Promise<TypstSnippet> | null = null;
let configKey = "";
let localConfigKey = "";

function compilerWasmUrl(appOrigin: string) {
  return new URL("/typst-wasm/typst_ts_web_compiler_bg.wasm", appOrigin).toString();
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
  const nextKey = JSON.stringify({
    coreApiUrl: coreApiUrl.replace(/\/$/, ""),
    appOrigin,
    fontCount: fontData.length,
    fontSizes: fontData.map((f) => f.byteLength)
  });
  if (!typstPromise || configKey !== nextKey) {
    configKey = nextKey;
    typstPromise = (async () => {
      const typst = new TypstSnippet();
      const accessModel = new NormalizedFetchAccessModel(
        `${coreApiUrl.replace(/\/$/, "")}/v1/typst/packages`
      );
      const beforeBuild = [
        withAccessModel(accessModel),
        withPackageRegistry(new FetchPackageRegistry(accessModel)),
        disableDefaultFontAssets()
      ];
      beforeBuild.push(loadFonts(fontData));
      typst.setCompilerInitOptions({
        beforeBuild,
        getModule: async () =>
          fetchArrayBufferWithContext(compilerWasmUrl(appOrigin), "compiler wasm")
      });
      return typst;
    })();
  }
  return typstPromise;
}

async function getLocalTypst(fontData: Uint8Array[], appOrigin: string) {
  const nextKey = JSON.stringify({
    appOrigin,
    fontCount: fontData.length,
    fontSizes: fontData.map((f) => f.byteLength)
  });
  if (!localTypstPromise || localConfigKey !== nextKey) {
    localConfigKey = nextKey;
    localTypstPromise = (async () => {
      const typst = new TypstSnippet();
      const beforeBuild = [disableDefaultFontAssets()];
      beforeBuild.push(loadFonts(fontData));
      typst.setCompilerInitOptions({
        beforeBuild,
        getModule: async () =>
          fetchArrayBufferWithContext(compilerWasmUrl(appOrigin), "compiler wasm")
      });
      return typst;
    })();
  }
  return localTypstPromise;
}

function sourceLikelyNeedsPackages(source: string) {
  return (
    source.includes("@preview/") ||
    source.includes("@local/") ||
    source.includes("@github/")
  );
}

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const { id, source, coreApiUrl, fontData } = event.data;
  const appOrigin = event.data.appOrigin ?? self.location.origin;
  try {
    const localTypst = await getLocalTypst(fontData, appOrigin);
    const vector = await localTypst.vector({ mainContent: source });
    self.postMessage({
      id,
      ok: !!vector,
      vectorBytes: vector,
      errors: []
    } satisfies CompileResponse);
    return;
  } catch (localErr) {
    const localError = localErr instanceof Error ? localErr.message : "Typst compile failed";
    if (sourceLikelyNeedsPackages(source)) {
      try {
        const typst = await getTypst(coreApiUrl, fontData, appOrigin);
        const vector = await typst.vector({ mainContent: source });
        self.postMessage({
          id,
          ok: !!vector,
          vectorBytes: vector,
          errors: []
        } satisfies CompileResponse);
        return;
      } catch (pkgErr) {
        const pkgError = pkgErr instanceof Error ? pkgErr.message : "package compile failed";
        self.postMessage({
          id,
          ok: false,
          errors: [`${localError} (package retry: ${pkgError})`]
        } satisfies CompileResponse);
        return;
      }
    }
    self.postMessage({
      id,
      ok: false,
      errors: [localError]
    } satisfies CompileResponse);
  }
};
