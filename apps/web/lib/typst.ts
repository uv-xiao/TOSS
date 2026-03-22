export type CompileOutput = {
  pdfDataUrl: string | null;
  errors: string[];
  compiledAt: number;
};

type WorkerCompileResponse = {
  id: number;
  ok: boolean;
  pdfBytes?: Uint8Array;
  errors?: string[];
};

class TypstWorkerRuntime {
  private worker: Worker | null = null;
  private seq = 1;
  private pending = new Map<number, (response: WorkerCompileResponse) => void>();

  private ensureWorker() {
    if (typeof window === "undefined") return null;
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    this.worker = new Worker(new URL("./typst.worker.ts", import.meta.url));
    this.worker.onmessage = (event: MessageEvent<WorkerCompileResponse>) => {
      const response = event.data;
      const resolve = this.pending.get(response.id);
      if (!resolve) return;
      this.pending.delete(response.id);
      resolve(response);
    };
    this.worker.onerror = () => {
      for (const resolve of this.pending.values()) {
        resolve({ id: -1, ok: false, errors: ["Typst worker crashed"] });
      }
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    return this.worker;
  }

  compile(source: string): Promise<WorkerCompileResponse> {
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve({
        id: -1,
        ok: false,
        errors: ["This browser does not support Worker-based Typst preview"]
      });
    }
    const id = this.seq++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage({ id, source });
    });
  }
}

const runtime = new TypstWorkerRuntime();

export async function compileTypstClientSide(source: string): Promise<CompileOutput> {
  if (source.trim().length === 0) {
    return {
      pdfDataUrl: null,
      errors: ["Document is empty"],
      compiledAt: Date.now()
    };
  }

  const result = await runtime.compile(source);
  if (result.ok && result.pdfBytes && result.pdfBytes.byteLength > 0) {
    const bytes = result.pdfBytes;
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([buffer], { type: "application/pdf" });
    return {
      pdfDataUrl: URL.createObjectURL(blob),
      errors: [],
      compiledAt: Date.now()
    };
  }

  return {
    pdfDataUrl: null,
    errors: result.errors?.length
      ? result.errors
      : [
          "This browser cannot run Typst WASM preview. You can continue editing source and sync via Git for offline compilation."
        ],
    compiledAt: Date.now()
  };
}
