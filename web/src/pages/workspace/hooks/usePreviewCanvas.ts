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

function previewScrollbarWidth(frame: HTMLElement) {
  const style = window.getComputedStyle(frame);
  const borderLeft = Number.parseFloat(style.borderLeftWidth || "0") || 0;
  const borderRight = Number.parseFloat(style.borderRightWidth || "0") || 0;
  const width = frame.getBoundingClientRect().width;
  return Math.max(0, width - frame.clientWidth - borderLeft - borderRight);
}

function syncPreviewScrollbarWidth(frame: HTMLElement) {
  const width = previewScrollbarWidth(frame);
  frame.style.setProperty("--preview-scrollbar-width", `${Math.round(width * 10) / 10}px`);
}

type PreviewViewportAnchor = {
  xRatio: number;
  yRatio: number;
};

const FIT_ZOOM_SYNC_EPSILON = 0.03;

function captureViewportAnchor(frame: HTMLElement): PreviewViewportAnchor {
  const scrollWidth = Math.max(1, frame.scrollWidth);
  const scrollHeight = Math.max(1, frame.scrollHeight);
  const centerX = frame.scrollLeft + frame.clientWidth / 2;
  const centerY = frame.scrollTop + frame.clientHeight / 2;
  return {
    xRatio: centerX / scrollWidth,
    yRatio: centerY / scrollHeight
  };
}

function restoreViewportAnchor(frame: HTMLElement, anchor: PreviewViewportAnchor) {
  const scrollWidth = Math.max(1, frame.scrollWidth);
  const scrollHeight = Math.max(1, frame.scrollHeight);
  const targetCenterX = anchor.xRatio * scrollWidth;
  const targetCenterY = anchor.yRatio * scrollHeight;
  const maxLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
  const maxTop = Math.max(0, frame.scrollHeight - frame.clientHeight);
  const nextLeft = Math.min(maxLeft, Math.max(0, targetCenterX - frame.clientWidth / 2));
  const nextTop = Math.min(maxTop, Math.max(0, targetCenterY - frame.clientHeight / 2));
  frame.scrollLeft = nextLeft;
  frame.scrollTop = nextTop;
}

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
  const lastAppliedZoomRef = useRef<number>(previewZoom);
  const [previewRenderTick, setPreviewRenderTick] = useState(0);
  const [previewIsPanning, setPreviewIsPanning] = useState(false);
  const [previewRendering, setPreviewRendering] = useState(false);
  const [hasPreviewPage, setHasPreviewPage] = useState(false);
  const [previewPageCurrent, setPreviewPageCurrent] = useState(0);
  const [previewPageTotal, setPreviewPageTotal] = useState(0);

  const collectRenderedPages = (frame: HTMLElement): HTMLElement[] => {
    const wrapperPages = Array.from(frame.querySelectorAll(".pdf-pages .typst-page")) as HTMLElement[];
    if (wrapperPages.length > 0) return wrapperPages;
    return Array.from(frame.querySelectorAll(".pdf-pages canvas")) as HTMLElement[];
  };

  const refreshPageIndicator = (frame: HTMLElement) => {
    const pages = collectRenderedPages(frame);
    if (pages.length === 0) {
      setPreviewPageCurrent(0);
      setPreviewPageTotal(0);
      return;
    }
    const frameRect = frame.getBoundingClientRect();
    const centerY = frameRect.top + frame.clientHeight / 2;
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pages.length; i += 1) {
      const rect = pages[i].getBoundingClientRect();
      const pageCenter = rect.top + rect.height / 2;
      const distance = Math.abs(pageCenter - centerY);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    setPreviewPageCurrent(bestIndex + 1);
    setPreviewPageTotal(pages.length);
  };

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
    syncPreviewScrollbarWidth(frame);
    const preRenderAnchor = captureViewportAnchor(frame);
    if (!vectorData) {
      lastRenderSignatureRef.current = "";
      setPreviewRendering(false);
      setHasPreviewPage(!!frame.querySelector(".pdf-pages .typst-page, .pdf-pages canvas"));
      refreshPageIndicator(frame);
      setPreviewRenderTick((value) => value + 1);
      return;
    }
    const renderSignature = `${previewPixelPerPt}:${vectorData.byteLength}:${vectorData[0] ?? 0}:${
      vectorData[Math.floor(vectorData.byteLength / 2)] ?? 0
    }:${vectorData[vectorData.byteLength - 1] ?? 0}`;
    const alreadyRendered =
      lastRenderSignatureRef.current === renderSignature && !!frame.querySelector(".pdf-pages .typst-page, .pdf-pages canvas");
    if (alreadyRendered) {
      setPreviewRendering(false);
      setHasPreviewPage(true);
      refreshPageIndicator(frame);
      setPreviewRenderTick((value) => value + 1);
      return;
    }
    let cancelled = false;
    setPreviewRendering(true);
    renderTypstVectorToCanvas(frame, vectorData, { pixelPerPt: previewPixelPerPt })
      .then(() => {
        if (cancelled) return;
        lastRenderSignatureRef.current = renderSignature;
        const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
        if (pages) {
          const fitMode = previewFitModeRef.current;
          const currentZoom = previewZoomRef.current;
          const zoom = fitMode === "manual" ? currentZoom : deriveFitZoom(frame, pages, fitMode);
          if (fitMode === "manual" || Math.abs(zoom - lastAppliedZoomRef.current) > FIT_ZOOM_SYNC_EPSILON) {
            applyPreviewZoom(frame, zoom);
            lastAppliedZoomRef.current = zoom;
          }
          syncPreviewScrollbarWidth(frame);
          restoreViewportAnchor(frame, preRenderAnchor);
          if (fitMode !== "manual" && Math.abs(zoom - currentZoom) > FIT_ZOOM_SYNC_EPSILON) {
            setPreviewZoom(zoom);
          }
        }
        setHasPreviewPage(!!frame.querySelector(".pdf-pages .typst-page, .pdf-pages canvas"));
        refreshPageIndicator(frame);
        setPreviewRenderTick((value) => value + 1);
        setPreviewRendering(false);
      })
      .catch((err) => {
        setHasPreviewPage(!!frame.querySelector(".pdf-pages .typst-page, .pdf-pages canvas"));
        refreshPageIndicator(frame);
        setPreviewRendering(false);
        const message = err instanceof Error ? err.message : "Preview render failed";
        onRenderErrorRef.current(message);
      });
    return () => {
      cancelled = true;
      setPreviewRendering(false);
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
    const anchor = captureViewportAnchor(frame);
    const zoom = previewFitMode === "manual" ? previewZoom : deriveFitZoom(frame, pages, previewFitMode);
    const shouldApply =
      previewFitMode === "manual" ||
      Math.abs(zoom - lastAppliedZoomRef.current) > FIT_ZOOM_SYNC_EPSILON;
    if (shouldApply) {
      applyPreviewZoom(frame, zoom);
      lastAppliedZoomRef.current = zoom;
    }
    syncPreviewScrollbarWidth(frame);
    restoreViewportAnchor(frame, anchor);
    if (previewFitMode !== "manual" && Math.abs(zoom - previewZoom) > FIT_ZOOM_SYNC_EPSILON) {
      setPreviewZoom(zoom);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFitMode, previewRenderTick, previewZoom, ...reflowDeps]);

  useEffect(() => {
    if (!showPreviewPanel) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    let rafId = 0;
    const onResize = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        syncPreviewScrollbarWidth(frame);
        const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
        if (!pages || previewFitMode === "manual") return;
        const anchor = captureViewportAnchor(frame);
        const zoom = deriveFitZoom(frame, pages, previewFitMode);
        const shouldApply = Math.abs(zoom - lastAppliedZoomRef.current) > FIT_ZOOM_SYNC_EPSILON;
        if (!shouldApply) return;
        applyPreviewZoom(frame, zoom);
        lastAppliedZoomRef.current = zoom;
        syncPreviewScrollbarWidth(frame);
        restoreViewportAnchor(frame, anchor);
        setPreviewZoom((current) =>
          Math.abs(current - zoom) > FIT_ZOOM_SYNC_EPSILON ? zoom : current
        );
      });
    };
    const observer = new ResizeObserver(() => {
      onResize();
    });
    observer.observe(frame);
    onResize();
    return () => {
      observer.disconnect();
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [previewFitMode, setPreviewZoom, showPreviewPanel]);

  useEffect(() => {
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const onScroll = () => refreshPageIndicator(frame);
    frame.addEventListener("scroll", onScroll, { passive: true });
    refreshPageIndicator(frame);
    return () => frame.removeEventListener("scroll", onScroll);
  }, [previewRenderTick]);

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

  function jumpToPreviewPage(pageNumber: number) {
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const pages = collectRenderedPages(frame);
    if (pages.length === 0) return;
    const targetIndex = Math.min(pages.length - 1, Math.max(0, Math.floor(pageNumber) - 1));
    const target = pages[targetIndex];
    const desiredTop = target.offsetTop - Math.max(0, (frame.clientHeight - target.clientHeight) / 2);
    const maxTop = Math.max(0, frame.scrollHeight - frame.clientHeight);
    frame.scrollTop = Math.min(maxTop, Math.max(0, desiredTop));
    refreshPageIndicator(frame);
  }

  return {
    canvasPreviewRef,
    previewRenderTick,
    previewIsPanning,
    previewRendering,
    hasPreviewPage,
    previewPageCurrent,
    previewPageTotal,
    jumpToPreviewPage,
    beginPreviewPan
  };
}
