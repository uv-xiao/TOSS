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

type WorkerRuntimeStatus = {
  kind: "runtime.status";
  stage: "downloading-compiler" | "compiling" | "ready" | "idle";
  loaded_bytes?: number;
  total_bytes?: number;
};

type WorkerMessage = WorkerCompileResponse | WorkerRuntimeStatus;

export type TypstRuntimeStatus = {
  stage: "downloading-compiler" | "compiling" | "ready" | "idle";
  loadedBytes?: number;
  totalBytes?: number;
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
  private listeners = new Set<(status: TypstRuntimeStatus) => void>();
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
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const response = event.data;
      if (response && "kind" in response && response.kind === "runtime.status") {
        const status: TypstRuntimeStatus = {
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
          : "Typst worker crashed";
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

  private notify(status: TypstRuntimeStatus) {
    for (const listener of this.listeners) listener(status);
  }

  subscribe(listener: (status: TypstRuntimeStatus) => void) {
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
        errors: ["This browser does not support Worker-based Typst preview"]
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
      getModule: async () =>
        fetch(RENDERER_WASM_URL, { cache: "force-cache" }).then((resp) => resp.arrayBuffer())
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

export function subscribeTypstRuntimeStatus(listener: (status: TypstRuntimeStatus) => void) {
  return runtime.subscribe(listener);
}

export async function renderTypstVectorToCanvas(
  container: HTMLElement,
  vectorData: Uint8Array,
  options?: { pixelPerPt?: number }
) {
  const version = ++renderVersion;
  const pixelPerPt = Math.max(1, Math.min(8, options?.pixelPerPt ?? 2));
  renderQueue = renderQueue.catch(() => undefined).then(async () => {
    if (version !== renderVersion) return;
    const renderer = await getRenderer();
    if (version !== renderVersion) return;
    const staging = document.createElement("div");
    const pages = document.createElement("div");
    pages.className = "pdf-pages";
    staging.appendChild(pages);
    await renderer.renderToCanvas({
      format: "vector",
      container: pages,
      artifactContent: vectorData,
      backgroundColor: "#ffffff",
      pixelPerPt
    });
    for (const semanticLayer of Array.from(pages.querySelectorAll(".typst-html-semantics"))) {
      semanticLayer.remove();
    }
    for (const page of Array.from(pages.querySelectorAll(".typst-page"))) {
      const pageElement = page as HTMLElement;
      pageElement.style.overflow = "hidden";
      const transformWrapper = pageElement.querySelector(":scope > div") as HTMLElement | null;
      const innerCanvas = transformWrapper?.querySelector("canvas") as HTMLCanvasElement | null;
      const canvasWidthPx = innerCanvas?.width ?? 0;
      const canvasHeightPx = innerCanvas?.height ?? 0;
      const rect = pageElement.getBoundingClientRect();
      const baseWidth = Math.max(
        1,
        canvasWidthPx > 0 ? canvasWidthPx / pixelPerPt : rect.width || pageElement.clientWidth || 1
      );
      const baseHeight = Math.max(
        1,
        canvasHeightPx > 0 ? canvasHeightPx / pixelPerPt : rect.height || pageElement.clientHeight || 1
      );
      const canvasBaseWidth = Math.max(1, canvasWidthPx || Math.round(baseWidth));
      const canvasBaseHeight = Math.max(1, canvasHeightPx || Math.round(baseHeight));
      pageElement.dataset.baseWidth = `${baseWidth}`;
      pageElement.dataset.baseHeight = `${baseHeight}`;
      pageElement.dataset.baseScale = "1";
      pageElement.dataset.canvasWidth = `${canvasBaseWidth}`;
      pageElement.dataset.canvasHeight = `${canvasBaseHeight}`;
      if (transformWrapper) {
        const scaleX = baseWidth / canvasBaseWidth;
        const scaleY = baseHeight / canvasBaseHeight;
        transformWrapper.style.transformOrigin = "0 0";
        transformWrapper.style.transform = `scale(${scaleX}, ${scaleY})`;
      }
      if (innerCanvas) {
        innerCanvas.style.width = `${canvasBaseWidth}px`;
        innerCanvas.style.height = `${canvasBaseHeight}px`;
      }
    }
    for (const canvas of Array.from(pages.querySelectorAll("canvas"))) {
      const styleWidth = Number.parseFloat(canvas.style.width || "");
      const styleHeight = Number.parseFloat(canvas.style.height || "");
      const rect = canvas.getBoundingClientRect();
      const baseWidth = Math.max(1, styleWidth || rect.width || canvas.clientWidth || canvas.width || 1);
      const baseHeight = Math.max(1, styleHeight || rect.height || canvas.clientHeight || canvas.height || 1);
      canvas.dataset.baseWidth = `${Math.max(1, baseWidth)}`;
      canvas.dataset.baseHeight = `${Math.max(1, baseHeight)}`;
      canvas.style.width = `${Math.max(1, baseWidth)}px`;
      canvas.style.height = `${Math.max(1, baseHeight)}px`;
      canvas.style.display = "block";
    }
    if (version !== renderVersion) return;
    container.replaceChildren(pages);
  });
  await renderQueue;
}
