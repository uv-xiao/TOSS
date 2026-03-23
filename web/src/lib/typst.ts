import { createTypstRenderer } from "@myriaddreamin/typst.ts";

export type CompileOutput = {
  vectorData: Uint8Array | null;
  pdfData: Uint8Array | null;
  errors: string[];
  diagnostics: CompileDiagnostic[];
  compiledAt: number;
};

export type CompileDiagnostic = {
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
  line?: number;
  column?: number;
  raw: string;
};

type WorkerCompileResponse = {
  id: number;
  ok: boolean;
  vectorBytes?: Uint8Array;
  pdfBytes?: Uint8Array;
  errors?: string[];
  diagnostics?: CompileDiagnostic[];
};

export type CompileOptions = {
  entryFilePath: string;
  documents: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; contentBase64: string }>;
  coreApiUrl: string;
  fontData: Uint8Array[];
  appOrigin?: string;
};

class TypstWorkerRuntime {
  private worker: Worker | null = null;
  private seq = 1;
  private pending = new Map<number, (response: WorkerCompileResponse) => void>();
  private fatalError(response: WorkerCompileResponse) {
    return (
      !!response.errors &&
      response.errors.some((message) =>
        /memory access out of bounds|unreachable|RuntimeError/i.test(message)
      )
    );
  }

  private resetWorker() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
  }

  private ensureWorker() {
    if (typeof window === "undefined") return null;
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    this.worker = new Worker(new URL("./typst.worker.ts", import.meta.url), {
      type: "module"
    });
    this.worker.onmessage = (event: MessageEvent<WorkerCompileResponse>) => {
      const response = event.data;
      const resolve = this.pending.get(response.id);
      if (!resolve) return;
      this.pending.delete(response.id);
      resolve(response);
    };
    this.worker.onerror = (event) => {
      const detail =
        event && "message" in event && typeof event.message === "string"
          ? event.message
          : "Typst worker crashed";
      for (const resolve of this.pending.values()) {
        resolve({ id: -1, ok: false, errors: [detail] });
      }
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    return this.worker;
  }

  compile(options: CompileOptions): Promise<WorkerCompileResponse> {
    const worker = this.ensureWorker();
    if (!worker) {
      return Promise.resolve({
        id: -1,
        ok: false,
        errors: ["This browser does not support Worker-based Typst preview"]
      });
    }
    const id = this.seq++;
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
        fontData: options.fontData,
        appOrigin: options.appOrigin
      });
    }).then((response) => {
      if (!response.ok && this.fatalError(response)) {
        this.resetWorker();
      }
      return response;
    });
  }
}

let rendererPromise: ReturnType<typeof createTypstRenderer> | null = null;
let renderQueue: Promise<void> = Promise.resolve();
let renderVersion = 0;
const RENDERER_WASM_URL =
  typeof window === "undefined"
    ? "/typst-wasm/typst_ts_renderer_bg.wasm"
    : new URL("/typst-wasm/typst_ts_renderer_bg.wasm", window.location.origin).toString();

async function getRenderer() {
  if (!rendererPromise) {
    const renderer = createTypstRenderer();
    await renderer.init({
      getModule: async () => fetch(RENDERER_WASM_URL).then((resp) => resp.arrayBuffer())
    });
    rendererPromise = renderer;
  }
  return rendererPromise;
}

const runtime = new TypstWorkerRuntime();

export async function compileTypstClientSide(options: CompileOptions): Promise<CompileOutput> {
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
  if (result.ok && result.vectorBytes && result.vectorBytes.byteLength > 0) {
    return {
      vectorData: result.vectorBytes,
      pdfData: result.pdfBytes ?? null,
      errors: [],
      diagnostics: result.diagnostics ?? [],
      compiledAt: Date.now()
    };
  }
  return {
    vectorData: null,
    pdfData: null,
    errors: result.errors?.length
      ? result.errors
      : [
          "This browser cannot run Typst WASM preview. You can continue editing source and sync via Git for offline compilation."
        ],
    diagnostics: result.diagnostics ?? [],
    compiledAt: Date.now()
  };
}

export async function renderTypstVectorToCanvas(container: HTMLElement, vectorData: Uint8Array) {
  const version = ++renderVersion;
  renderQueue = renderQueue.catch(() => undefined).then(async () => {
    if (version !== renderVersion) return;
    const renderer = await getRenderer();
    if (version !== renderVersion) return;
    container.replaceChildren();
    const pages = document.createElement("div");
    pages.className = "pdf-pages";
    container.appendChild(pages);
    await renderer.renderToCanvas({
      format: "vector",
      container: pages,
      artifactContent: vectorData,
      backgroundColor: "#ffffff",
      pixelPerPt: 2
    });
    for (const semanticLayer of Array.from(pages.querySelectorAll(".typst-html-semantics"))) {
      semanticLayer.remove();
    }
    for (const page of Array.from(pages.querySelectorAll(".typst-page"))) {
      const pageElement = page as HTMLElement;
      pageElement.style.overflow = "hidden";
      const styleWidth = Number.parseFloat(pageElement.style.width || "");
      const styleHeight = Number.parseFloat(pageElement.style.height || "");
      const rect = pageElement.getBoundingClientRect();
      const baseWidth = Math.max(1, styleWidth || rect.width || pageElement.clientWidth || 1);
      const baseHeight = Math.max(1, styleHeight || rect.height || pageElement.clientHeight || 1);
      pageElement.dataset.baseWidth = `${baseWidth}`;
      pageElement.dataset.baseHeight = `${baseHeight}`;
    }
    for (const canvas of Array.from(pages.querySelectorAll("canvas"))) {
      const baseWidth = canvas.width > 0 ? canvas.width / 2 : canvas.clientWidth;
      const baseHeight = canvas.height > 0 ? canvas.height / 2 : canvas.clientHeight;
      canvas.dataset.baseWidth = `${Math.max(1, baseWidth)}`;
      canvas.dataset.baseHeight = `${Math.max(1, baseHeight)}`;
      canvas.style.width = `${Math.max(1, baseWidth)}px`;
      canvas.style.height = `${Math.max(1, baseHeight)}px`;
      canvas.style.display = "block";
    }
  });
  await renderQueue;
}
