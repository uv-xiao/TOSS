import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { renderTypstVectorToCanvas } from "@/lib/typst";
import type { PreviewFitMode } from "@/pages/workspace/types";
import { applyPreviewZoom, deriveFitZoom } from "@/pages/workspace/utils";

type UsePreviewCanvasParams = {
  showPreviewPanel: boolean;
  vectorData: Uint8Array | null;
  previewPixelPerPt: number;
  previewFitMode: PreviewFitMode;
  previewZoom: number;
  setPreviewZoom: (updater: number | ((current: number) => number)) => void;
  reflowDeps: ReadonlyArray<unknown>;
  onRenderError: (message: string) => void;
};

export function usePreviewCanvas({
  showPreviewPanel,
  vectorData,
  previewPixelPerPt,
  previewFitMode,
  previewZoom,
  setPreviewZoom,
  reflowDeps,
  onRenderError
}: UsePreviewCanvasParams) {
  const canvasPreviewRef = useRef<HTMLDivElement | null>(null);
  const previewPanCleanupRef = useRef<(() => void) | null>(null);
  const [previewRenderTick, setPreviewRenderTick] = useState(0);
  const [previewIsPanning, setPreviewIsPanning] = useState(false);

  useEffect(() => {
    return () => {
      if (previewPanCleanupRef.current) {
        previewPanCleanupRef.current();
        previewPanCleanupRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!showPreviewPanel) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    if (!vectorData) {
      setPreviewRenderTick((value) => value + 1);
      return;
    }
    let cancelled = false;
    renderTypstVectorToCanvas(frame, vectorData, { pixelPerPt: previewPixelPerPt })
      .then(() => {
        if (cancelled) return;
        const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
        if (pages) {
          const zoom = previewFitMode === "manual" ? previewZoom : deriveFitZoom(frame, pages, previewFitMode);
          applyPreviewZoom(frame, zoom);
          if (previewFitMode !== "manual" && Math.abs(zoom - previewZoom) > 0.01) {
            setPreviewZoom(zoom);
          }
        }
        setPreviewRenderTick((value) => value + 1);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Preview render failed";
        onRenderError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    onRenderError,
    previewFitMode,
    previewPixelPerPt,
    previewZoom,
    setPreviewZoom,
    showPreviewPanel,
    vectorData
  ]);

  useEffect(() => {
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
    if (!pages) return;
    const zoom = previewFitMode === "manual" ? previewZoom : deriveFitZoom(frame, pages, previewFitMode);
    applyPreviewZoom(frame, zoom);
    if (previewFitMode !== "manual" && Math.abs(zoom - previewZoom) > 0.01) {
      setPreviewZoom(zoom);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFitMode, previewRenderTick, previewZoom, ...reflowDeps]);

  useEffect(() => {
    if (!showPreviewPanel) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => {
      const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
      if (!pages || previewFitMode === "manual") return;
      const zoom = deriveFitZoom(frame, pages, previewFitMode);
      applyPreviewZoom(frame, zoom);
      setPreviewZoom(zoom);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [previewFitMode, setPreviewZoom, showPreviewPanel]);

  useEffect(() => {
    if (!showPreviewPanel) return;
    if (previewFitMode === "manual") return;
    const onResize = () => {
      const frame = canvasPreviewRef.current;
      if (!frame) return;
      const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
      if (!pages) return;
      const zoom = deriveFitZoom(frame, pages, previewFitMode);
      applyPreviewZoom(frame, zoom);
      setPreviewZoom(zoom);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [previewFitMode, setPreviewZoom, showPreviewPanel]);

  function beginPreviewPan(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const pages = frame.querySelector(".pdf-pages");
    if (!pages) return;
    const canPanX = frame.scrollWidth > frame.clientWidth + 1;
    const canPanY = frame.scrollHeight > frame.clientHeight + 1;
    if (!canPanX && !canPanY) return;

    const startX = event.clientX;
    const startY = event.clientY;
    const initialScrollLeft = frame.scrollLeft;
    const initialScrollTop = frame.scrollTop;
    setPreviewIsPanning(true);
    event.preventDefault();

    const onMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (canPanX) frame.scrollLeft = initialScrollLeft - deltaX;
      if (canPanY) frame.scrollTop = initialScrollTop - deltaY;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      previewPanCleanupRef.current = null;
      setPreviewIsPanning(false);
    };
    previewPanCleanupRef.current = onUp;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return {
    canvasPreviewRef,
    previewRenderTick,
    previewIsPanning,
    beginPreviewPan
  };
}

