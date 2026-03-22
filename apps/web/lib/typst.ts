export type CompileOutput = {
  pdfDataUrl: string | null;
  errors: string[];
  compiledAt: number;
};

const encoder = new TextEncoder();

function fakePdfFromSource(source: string): string {
  const payload = btoa(
    unescape(encodeURIComponent(`Typst preview placeholder\n\n${source}`))
  );
  return `data:application/pdf;base64,${payload}`;
}

export async function compileTypstClientSide(source: string): Promise<CompileOutput> {
  if (source.trim().length === 0) {
    return {
      pdfDataUrl: null,
      errors: ["Document is empty"],
      compiledAt: Date.now()
    };
  }

  encoder.encode(source);

  if (source.includes("compile_error_demo")) {
    return {
      pdfDataUrl: null,
      errors: ["Compilation error: unknown identifier `compile_error_demo`"],
      compiledAt: Date.now()
    };
  }

  return {
    pdfDataUrl: fakePdfFromSource(source),
    errors: [],
    compiledAt: Date.now()
  };
}

