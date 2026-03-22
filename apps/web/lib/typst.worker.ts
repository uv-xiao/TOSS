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
let fallbackTypstPromise: Promise<TypstSnippet> | null = null;
let configKey = "";
let fallbackConfigKey = "";
const COMPILER_WASM_URL = "/typst-wasm/typst_ts_web_compiler_bg.wasm";

async function getTypst(coreApiUrl: string, fontData: Uint8Array[]) {
  const nextKey = JSON.stringify({
    coreApiUrl: coreApiUrl.replace(/\/$/, ""),
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
      if (fontData.length > 0) {
        beforeBuild.push(loadFonts(fontData));
      }
      typst.setCompilerInitOptions({
        beforeBuild,
        getModule: async () => fetch(COMPILER_WASM_URL).then((resp) => resp.arrayBuffer())
      });
      return typst;
    })();
  }
  return typstPromise;
}

async function getFallbackTypst(fontData: Uint8Array[]) {
  const nextKey = JSON.stringify({
    fontCount: fontData.length,
    fontSizes: fontData.map((f) => f.byteLength)
  });
  if (!fallbackTypstPromise || fallbackConfigKey !== nextKey) {
    fallbackConfigKey = nextKey;
    fallbackTypstPromise = (async () => {
      const typst = new TypstSnippet();
      const beforeBuild = [disableDefaultFontAssets()];
      if (fontData.length > 0) {
        beforeBuild.push(loadFonts(fontData));
      }
      typst.setCompilerInitOptions({
        beforeBuild,
        getModule: async () => fetch(COMPILER_WASM_URL).then((resp) => resp.arrayBuffer())
      });
      return typst;
    })();
  }
  return fallbackTypstPromise;
}

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const { id, source, coreApiUrl, fontData } = event.data;
  try {
    const typst = await getTypst(coreApiUrl, fontData);
    const vector = await typst.vector({ mainContent: source });
    const errors: string[] = [];
    const response: CompileResponse = {
      id, 
      ok: !!vector && errors.length === 0,
      vectorBytes: vector,
      errors,
    };
    self.postMessage(response);
  } catch (err) {
    const primaryError = err instanceof Error ? err.message : "Typst compile failed";
    if (primaryError.includes("Failed to fetch")) {
      try {
        const fallback = await getFallbackTypst(fontData);
        const vector = await fallback.vector({ mainContent: source });
        const response: CompileResponse = {
          id,
          ok: !!vector,
          vectorBytes: vector,
          errors: vector ? [] : ["Typst compile failed"]
        };
        self.postMessage(response);
        return;
      } catch (fallbackErr) {
        const fallbackError =
          fallbackErr instanceof Error ? fallbackErr.message : "fallback compile failed";
        self.postMessage({
          id,
          ok: false,
          errors: [`${primaryError} (fallback: ${fallbackError})`]
        } satisfies CompileResponse);
        return;
      }
    }
    self.postMessage({
      id,
      ok: false,
      errors: [primaryError]
    } satisfies CompileResponse);
  }
};
