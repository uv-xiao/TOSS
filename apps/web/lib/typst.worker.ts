import { CompileFormatEnum, createTypstCompiler } from "@myriaddreamin/typst.ts/compiler";
import type { TypstCompiler } from "@myriaddreamin/typst.ts/compiler";

type CompileRequest = {
  id: number;
  source: string;
};

type CompileResponse = {
  id: number;
  ok: boolean;
  pdfBytes?: Uint8Array;
  errors?: string[];
};

const MAIN_PATH = "/main.typ";
let compilerPromise: Promise<TypstCompiler> | null = null;

async function getCompiler() {
  if (!compilerPromise) {
    compilerPromise = (async () => {
      const compiler = createTypstCompiler();
      await compiler.init();
      compiler.addSource(MAIN_PATH, "");
      return compiler;
    })();
  }
  return compilerPromise;
}

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

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const { id, source } = event.data;
  try {
    const compiler = await getCompiler();
    compiler.addSource(MAIN_PATH, source);
    const result = await compiler.compile({
      mainFilePath: MAIN_PATH,
      format: CompileFormatEnum.pdf,
      diagnostics: "full"
    });
    const errors = extractErrors(result?.diagnostics);
    const response: CompileResponse = {
      id,
      ok: !!result?.result && errors.length === 0,
      pdfBytes: result?.result,
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
