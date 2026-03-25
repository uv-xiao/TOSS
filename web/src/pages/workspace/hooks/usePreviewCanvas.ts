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
  const onRenderErrorRef = useRef(onRenderError);
  const previewFitModeRef = useRef(previewFitMode);
  const previewZoomRef = useRef(previewZoom);
  const lastRenderSignatureRef = useRef<string>("");
  const [previewRenderTick, setPreviewRenderTick] = useState(0);
  const [previewIsPanning, setPreviewIsPanning] = useState(false);
  const [hasPreviewPage, setHasPreviewPage] = useState(false);

  useEffect(() => {
    onRenderErrorRef.current = onRenderError;
  }, [onRenderError]);

  useEffect(() => {
    previewFitModeRef.current = previewFitMode;
  }, [previewFitMode]);

  useEffect(() => {
    previewZoomRef.current = previewZoom;
  }, [previewZoom]);

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
      lastRenderSignatureRef.current = "";
      setHasPreviewPage(!!frame.querySelector(".pdf-pages .typst-page, .pdf-pages canvas"));
      setPreviewRenderTick((value) => value + 1);
      return;
    }
    const renderSignature = `${previewPixelPerPt}:${vectorData.byteLength}:${vectorData[0] ?? 0}:${
      vectorData[Math.floor(vectorData.byteLength / 2)] ?? 0
    }:${vectorData[vectorData.byteLength - 1] ?? 0}`;
    const alreadyRendered =
      lastRenderSignatureRef.current === renderSignature && !!frame.querySelector(".pdf-pages .typst-page, .pdf-pages canvas");
    if (alreadyRendered) {
      setHasPreviewPage(true);
      setPreviewRenderTick((value) => value + 1);
      return;
    }
    let cancelled = false;
    renderTypstVectorToCanvas(frame, vectorData, { pixelPerPt: previewPixelPerPt })
      .then(() => {
        if (cancelled) return;
        lastRenderSignatureRef.current = renderSignature;
        const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
        if (pages) {
          const fitMode = previewFitModeRef.current;
          const currentZoom = previewZoomRef.current;
          const zoom = fitMode === "manual" ? currentZoom : deriveFitZoom(frame, pages, fitMode);
          applyPreviewZoom(frame, zoom);
          if (fitMode !== "manual" && frame.scrollLeft !== 0) {
            frame.scrollLeft = 0;
          }
          if (fitMode !== "manual" && Math.abs(zoom - currentZoom) > 0.01) {
            setPreviewZoom(zoom);
          }
        }
        setHasPreviewPage(!!frame.querySelector(".pdf-pages .typst-page, .pdf-pages canvas"));
        setPreviewRenderTick((value) => value + 1);
      })
      .catch((err) => {
        setHasPreviewPage(!!frame.querySelector(".pdf-pages .typst-page, .pdf-pages canvas"));
        const message = err instanceof Error ? err.message : "Preview render failed";
        onRenderErrorRef.current(message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    previewPixelPerPt,
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
    if (previewFitMode !== "manual" && frame.scrollLeft !== 0) {
      frame.scrollLeft = 0;
    }
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
      if (frame.scrollLeft !== 0) {
        frame.scrollLeft = 0;
      }
      setPreviewZoom((current) => (Math.abs(current - zoom) > 0.01 ? zoom : current));
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
      if (frame.scrollLeft !== 0) {
        frame.scrollLeft = 0;
      }
      setPreviewZoom((current) => (Math.abs(current - zoom) > 0.01 ? zoom : current));
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
    hasPreviewPage,
    beginPreviewPan
  };
}
