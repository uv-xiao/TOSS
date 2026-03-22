export type CompileOutput = {
  pdfDataUrl: string | null;
  errors: string[];
  compiledAt: number;
};

const encoder = new TextEncoder();
let typstPromise: Promise<typeof import("@myriaddreamin/typst.ts")> | null = null;

function getTypstModule() {
  if (!typstPromise) {
    typstPromise = import("@myriaddreamin/typst.ts");
  }
  return typstPromise;
}

function fakePdfFromSource(source: string): string {
  const payload = btoa(
    unescape(encodeURIComponent(`Typst preview placeholder\n\n${source}`))
  );
  return `data:application/pdf;base64,${payload}`;
}

async function compileWithTypstWasm(source: string): Promise<string | null> {
  try {
    const { $typst } = await getTypstModule();
    const result = await $typst.pdf({
      mainContent: source
    });
    if (!result || result.byteLength === 0) return null;
    const bytes = new Uint8Array(result);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([buffer], { type: "application/pdf" });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
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

  const wasmPdf = await compileWithTypstWasm(source);
  if (wasmPdf) {
    return {
      pdfDataUrl: wasmPdf,
      errors: [],
      compiledAt: Date.now()
    };
  }

  return {
    pdfDataUrl: fakePdfFromSource(source),
    errors: ["Typst WASM runtime unavailable, using fallback preview"],
    compiledAt: Date.now()
  };
}
