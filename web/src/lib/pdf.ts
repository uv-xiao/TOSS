import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

let workerConfigured = false;

function ensurePdfWorkerConfigured() {
  if (workerConfigured) return;
  GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  workerConfigured = true;
}

export async function renderPdfBytesToCanvas(
  container: HTMLElement,
  pdfBytes: Uint8Array,
  options?: { pixelPerPt?: number }
) {
  ensurePdfWorkerConfigured();
  const loadingTask = getDocument({
    data: pdfBytes.slice().buffer
  });
  const pdf = await loadingTask.promise;
  const pages = document.createElement("div");
  pages.className = "pdf-pages";
  const qualityScale = Math.max(1, Math.min(6, (options?.pixelPerPt ?? 3) * 0.75));
  const deviceScale = Math.max(1, window.devicePixelRatio || 1);
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const pageWrapper = document.createElement("div");
    pageWrapper.className = "typst-page";
    pageWrapper.style.position = "relative";
    pageWrapper.style.overflow = "hidden";
    pageWrapper.style.width = `${viewport.width}px`;
    pageWrapper.style.height = `${viewport.height}px`;
    pageWrapper.dataset.baseWidth = `${viewport.width}`;
    pageWrapper.dataset.baseHeight = `${viewport.height}`;
    const canvas = document.createElement("canvas");
    canvas.className = "typst-page-canvas";
    canvas.style.display = "block";
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.dataset.baseWidth = `${viewport.width}`;
    canvas.dataset.baseHeight = `${viewport.height}`;
    canvas.width = Math.ceil(viewport.width * qualityScale * deviceScale);
    canvas.height = Math.ceil(viewport.height * qualityScale * deviceScale);
    const context = canvas.getContext("2d");
    if (!context) continue;
    context.setTransform(qualityScale * deviceScale, 0, 0, qualityScale * deviceScale, 0, 0);
    await page.render({
      canvasContext: context,
      viewport
    }).promise;
    pageWrapper.appendChild(canvas);
    pages.appendChild(pageWrapper);
  }
  container.innerHTML = "";
  container.appendChild(pages);
  await loadingTask.destroy();
}
