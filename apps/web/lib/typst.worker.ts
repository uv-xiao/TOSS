import { createTypstCompiler, CompileFormatEnum } from "@myriaddreamin/typst.ts/compiler";
import { FetchAccessModel } from "@myriaddreamin/typst.ts/fs/fetch";
import { FetchPackageRegistry } from "@myriaddreamin/typst.ts/fs/package";
import { loadFonts, withAccessModel, withPackageRegistry } from "@myriaddreamin/typst.ts/options.init";
import type { TypstCompiler } from "@myriaddreamin/typst.ts/compiler";

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

const MAIN_PATH = "/main.typ";
let compilerPromise: Promise<TypstCompiler> | null = null;
let configKey = "";

function extractErrors(diagnostics: unknown): string[] {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics
    .map((d) => {
      if (typeof d === "string") return d;
      if (d && typeof d === "object" && "message" in d) {
        return String((d as { message: unknown }).message ?? "compile error");
      }
      return "compile error";
    })
    .filter((x) => x.trim().length > 0);
}

async function getCompiler(coreApiUrl: string, fontData: Uint8Array[]) {
  const nextKey = JSON.stringify({
    coreApiUrl: coreApiUrl.replace(/\/$/, ""),
    fontCount: fontData.length,
    fontSizes: fontData.map((f) => f.byteLength)
  });
  if (!compilerPromise || configKey !== nextKey) {
    configKey = nextKey;
    compilerPromise = (async () => {
      const compiler = createTypstCompiler();
      const accessModel = new FetchAccessModel(
        `${coreApiUrl.replace(/\/$/, "")}/v1/typst/packages`
      );
      const beforeBuild = [
        withAccessModel(accessModel),
        withPackageRegistry(new FetchPackageRegistry(accessModel))
      ];
      if (fontData.length > 0) {
        beforeBuild.push(loadFonts(fontData));
      }
      await compiler.init({ beforeBuild });
      compiler.addSource(MAIN_PATH, "");
      return compiler;
    })();
  }
  return compilerPromise;
}

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const { id, source, coreApiUrl, fontData } = event.data;
  try {
    const compiler = await getCompiler(coreApiUrl, fontData);
    compiler.addSource(MAIN_PATH, source);
    const result = await compiler.compile({
      mainFilePath: MAIN_PATH,
      format: CompileFormatEnum.vector,
      diagnostics: "full"
    });
    const errors = extractErrors(result?.diagnostics);
    const response: CompileResponse = {
      id,
      ok: !!result?.result && errors.length === 0,
      vectorBytes: result?.result,
      errors
    };
    self.postMessage(response);
  } catch (err) {
    const response: CompileResponse = {
      id,
      ok: false,
      errors: [err instanceof Error ? err.message : "Typst compile failed"]
    };
    self.postMessage(response);
  }
};
