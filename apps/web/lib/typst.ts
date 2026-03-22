import { createTypstRenderer } from "@myriaddreamin/typst.ts";

export type CompileOutput = {
  vectorData: Uint8Array | null;
  errors: string[];
  compiledAt: number;
};

type WorkerCompileResponse = {
  id: number;
  ok: boolean;
  vectorBytes?: Uint8Array;
  errors?: string[];
};

type CompileOptions = {
  coreApiUrl: string;
  fontData: Uint8Array[];
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

  compile(source: string, options: CompileOptions): Promise<WorkerCompileResponse> {
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
      worker.postMessage({
        id,
        source,
        coreApiUrl: options.coreApiUrl,
        fontData: options.fontData
      });
    });
  }
}

let rendererPromise: ReturnType<typeof createTypstRenderer> | null = null;
async function getRenderer() {
  if (!rendererPromise) {
    const renderer = createTypstRenderer();
    await renderer.init();
    rendererPromise = renderer;
  }
  return rendererPromise;
}

const runtime = new TypstWorkerRuntime();

export async function compileTypstClientSide(
  source: string,
  options: CompileOptions
): Promise<CompileOutput> {
  if (source.trim().length === 0) {
    return {
      vectorData: null,
      errors: ["Document is empty"],
      compiledAt: Date.now()
    };
  }
  const result = await runtime.compile(source, options);
  if (result.ok && result.vectorBytes && result.vectorBytes.byteLength > 0) {
    return {
      vectorData: result.vectorBytes,
      errors: [],
      compiledAt: Date.now()
    };
  }
  return {
    vectorData: null,
    errors: result.errors?.length
      ? result.errors
      : [
          "This browser cannot run Typst WASM preview. You can continue editing source and sync via Git for offline compilation."
        ],
    compiledAt: Date.now()
  };
}

export async function renderTypstVectorToCanvas(
  container: HTMLElement,
  vectorData: Uint8Array
) {
  const renderer = await getRenderer();
  container.replaceChildren();
  await renderer.renderToCanvas({
    format: "vector",
    container,
    artifactContent: vectorData,
    backgroundColor: "#ffffff",
    pixelPerPt: 2
  });
}
