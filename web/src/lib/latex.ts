import type { CompileDiagnostic } from "./typst";

export type LatexCompileOutput = {
  vectorData: Uint8Array | null;
  pdfData: Uint8Array | null;
  errors: string[];
  diagnostics: CompileDiagnostic[];
  compiledAt: number;
};

type WorkerCompileResponse = {
  id: number;
  ok: boolean;
  pdfBytes?: Uint8Array;
  errors?: string[];
  diagnostics?: CompileDiagnostic[];
};

type WorkerRuntimeStatus = {
  kind: "runtime.status";
  stage: "downloading-compiler" | "compiling" | "ready" | "idle";
  loaded_bytes?: number;
  total_bytes?: number;
};

type WorkerMessage = WorkerCompileResponse | WorkerRuntimeStatus;

export type LatexRuntimeStatus = {
  stage: "downloading-compiler" | "compiling" | "ready" | "idle";
  loadedBytes?: number;
  totalBytes?: number;
};

type CompileOptions = {
  entryFilePath: string;
  documents: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; contentBase64: string }>;
  coreApiUrl: string;
  appOrigin?: string;
  engine: "pdftex" | "xetex";
};

class LatexWorkerRuntime {
  private worker: Worker | null = null;
  private seq = 1;
  private pending = new Map<number, (response: WorkerCompileResponse) => void>();
  private listeners = new Set<(status: LatexRuntimeStatus) => void>();

  private ensureWorker() {
    if (typeof window === "undefined") return null;
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    this.worker = new Worker(new URL("./latex.worker.ts", import.meta.url), {
      type: "module"
    });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const response = event.data;
      if (response && "kind" in response && response.kind === "runtime.status") {
        const status: LatexRuntimeStatus = {
          stage: response.stage,
          loadedBytes: response.loaded_bytes,
          totalBytes: response.total_bytes
        };
        this.notify(status);
        return;
      }
      const compileResponse = response as WorkerCompileResponse;
      const resolve = this.pending.get(compileResponse.id);
      if (!resolve) return;
      this.pending.delete(compileResponse.id);
      resolve(compileResponse);
    };
    this.worker.onerror = (event) => {
      const detail =
        event && "message" in event && typeof event.message === "string"
          ? event.message
          : "LaTeX worker crashed";
      for (const resolve of this.pending.values()) {
        resolve({ id: -1, ok: false, errors: [detail] });
      }
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
      this.notify({ stage: "idle" });
    };
    return this.worker;
  }

  private notify(status: LatexRuntimeStatus) {
    for (const listener of this.listeners) listener(status);
  }

  subscribe(listener: (status: LatexRuntimeStatus) => void) {
    this.listeners.add(listener);
    listener({ stage: "idle" });
    return () => {
      this.listeners.delete(listener);
    };
  }

  compile(options: CompileOptions): Promise<WorkerCompileResponse> {
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve({
        id: -1,
        ok: false,
        errors: ["This browser does not support Worker-based LaTeX preview"]
      });
    }
    const id = this.seq++;
    this.notify({ stage: "compiling" });
    return new Promise<WorkerCompileResponse>((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage({
        id,
        entryFilePath: options.entryFilePath,
        documents: options.documents,
        assets: options.assets.map((asset) => ({
          path: asset.path,
          content_base64: asset.contentBase64
        })),
        coreApiUrl: options.coreApiUrl,
        appOrigin: options.appOrigin,
        engine: options.engine
      });
    });
  }
}

const runtime = new LatexWorkerRuntime();

export async function compileLatexClientSide(options: CompileOptions): Promise<LatexCompileOutput> {
  if (!options.documents.length) {
    return {
      vectorData: null,
      pdfData: null,
      errors: ["Project has no source documents"],
      diagnostics: [],
      compiledAt: Date.now()
    };
  }
  const result = await runtime.compile(options);
  if (result.ok && result.pdfBytes && result.pdfBytes.byteLength > 0) {
    return {
      vectorData: null,
      pdfData: result.pdfBytes,
      errors: [],
      diagnostics: result.diagnostics ?? [],
      compiledAt: Date.now()
    };
  }
  return {
    vectorData: null,
    pdfData: null,
    errors:
      result.errors?.length
        ? result.errors
        : [
            "This browser cannot run LaTeX WASM preview. You can continue editing source and sync via Git for offline compilation."
          ],
    diagnostics: result.diagnostics ?? [],
    compiledAt: Date.now()
  };
}

export function subscribeLatexRuntimeStatus(listener: (status: LatexRuntimeStatus) => void) {
  return runtime.subscribe(listener);
}
