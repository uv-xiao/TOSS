import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { renderTypstVectorToCanvas } from "@/lib/typst";
import { renderPdfBytesToCanvas } from "@/lib/pdf";
import type { PreviewFitMode } from "@/pages/workspace/types";
import { applyPreviewZoom, deriveFitZoom } from "@/pages/workspace/utils";

type UsePreviewCanvasParams = {
  showPreviewPanel: boolean;
  previewArtifactKind: "typst-vector" | "pdf";
  vectorData: Uint8Array | null;
  pdfData: Uint8Array | null;
  previewPixelPerPt: number;
  previewFitMode: PreviewFitMode;
  previewZoom: number;
  setPreviewZoom: (updater: number | ((current: number) => number)) => void;
  reflowDeps: ReadonlyArray<unknown>;
  onRenderError: (message: string) => void;
  initialViewportAnchor?: PreviewViewportAnchor | null;
  onViewportAnchorChange?: (anchor: PreviewViewportAnchor) => void;
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
  const maxLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
  const maxTop = Math.max(0, frame.scrollHeight - frame.clientHeight);
  return {
    xRatio: maxLeft > 0 ? Math.min(1, Math.max(0, frame.scrollLeft / maxLeft)) : 0,
    yRatio: maxTop > 0 ? Math.min(1, Math.max(0, frame.scrollTop / maxTop)) : 0
  };
}

function restoreViewportAnchor(frame: HTMLElement, anchor: PreviewViewportAnchor) {
  const maxLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
  const maxTop = Math.max(0, frame.scrollHeight - frame.clientHeight);
  const nextLeft = Math.min(maxLeft, Math.max(0, anchor.xRatio * maxLeft));
  const nextTop = Math.min(maxTop, Math.max(0, anchor.yRatio * maxTop));
  frame.scrollLeft = nextLeft;
  frame.scrollTop = nextTop;
}

export function usePreviewCanvas({
  showPreviewPanel,
  previewArtifactKind,
  vectorData,
  pdfData,
  previewPixelPerPt,
  previewFitMode,
  previewZoom,
  setPreviewZoom,
  reflowDeps,
  onRenderError,
  initialViewportAnchor,
  onViewportAnchorChange
}: UsePreviewCanvasParams) {
  const canvasPreviewRef = useRef<HTMLDivElement | null>(null);
  const previewPanCleanupRef = useRef<(() => void) | null>(null);
  const onRenderErrorRef = useRef(onRenderError);
  const previewFitModeRef = useRef(previewFitMode);
  const previewZoomRef = useRef(previewZoom);
  const lastRenderSignatureRef = useRef<string>("");
  const viewportAnchorRef = useRef<PreviewViewportAnchor>(initialViewportAnchor ?? { xRatio: 0, yRatio: 0 });
  const viewportAnchorHydratedRef = useRef(false);
  const onViewportAnchorChangeRef = useRef(onViewportAnchorChange);
  const [previewRenderTick, setPreviewRenderTick] = useState(0);
  const [previewIsPanning, setPreviewIsPanning] = useState(false);
  const [previewRendering, setPreviewRendering] = useState(false);
  const [hasPreviewPage, setHasPreviewPage] = useState(false);
  const [previewPageCurrent, setPreviewPageCurrent] = useState(0);
  const [previewPageTotal, setPreviewPageTotal] = useState(0);

  const canPersistViewportAnchor = (frame: HTMLElement) =>
    !!frame.querySelector(".pdf-pages .typst-page, .pdf-pages canvas");

  const emitViewportAnchor = (frame: HTMLElement) => {
    if (!canPersistViewportAnchor(frame)) return;
    onViewportAnchorChangeRef.current?.(viewportAnchorRef.current);
  };

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
    onViewportAnchorChangeRef.current = onViewportAnchorChange;
  }, [onViewportAnchorChange]);

  useEffect(() => {
    viewportAnchorRef.current = initialViewportAnchor ?? { xRatio: 0, yRatio: 0 };
    viewportAnchorHydratedRef.current = false;
  }, [initialViewportAnchor?.xRatio, initialViewportAnchor?.yRatio]);

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
    if (viewportAnchorHydratedRef.current) {
      viewportAnchorRef.current = captureViewportAnchor(frame);
    }
    if (viewportAnchorHydratedRef.current) emitViewportAnchor(frame);
    const artifactBytes = previewArtifactKind === "typst-vector" ? vectorData : pdfData;
    if (!artifactBytes) {
      lastRenderSignatureRef.current = "";
      setPreviewRendering(false);
      setHasPreviewPage(!!frame.querySelector(".pdf-pages .typst-page, .pdf-pages canvas"));
      refreshPageIndicator(frame);
      setPreviewRenderTick((value) => value + 1);
      return;
    }
    const renderSignature = `${previewArtifactKind}:${previewPixelPerPt}:${artifactBytes.byteLength}:${
      artifactBytes[0] ?? 0
    }:${artifactBytes[Math.floor(artifactBytes.byteLength / 2)] ?? 0}:${
      artifactBytes[artifactBytes.byteLength - 1] ?? 0
    }`;
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
    const renderPromise =
      previewArtifactKind === "typst-vector"
        ? renderTypstVectorToCanvas(frame, artifactBytes, { pixelPerPt: previewPixelPerPt })
        : renderPdfBytesToCanvas(frame, artifactBytes, { pixelPerPt: previewPixelPerPt });
    renderPromise
      .then(() => {
        if (cancelled) return;
        lastRenderSignatureRef.current = renderSignature;
        const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
        if (pages) {
          const fitMode = previewFitModeRef.current;
          const currentZoom = previewZoomRef.current;
          const zoom = fitMode === "manual" ? currentZoom : deriveFitZoom(frame, pages, fitMode);
          applyPreviewZoom(frame, zoom);
          syncPreviewScrollbarWidth(frame);
          if (!viewportAnchorHydratedRef.current) {
            restoreViewportAnchor(frame, viewportAnchorRef.current);
            viewportAnchorHydratedRef.current = true;
          } else {
            restoreViewportAnchor(frame, viewportAnchorRef.current);
          }
          viewportAnchorRef.current = captureViewportAnchor(frame);
          emitViewportAnchor(frame);
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
    previewArtifactKind,
    previewPixelPerPt,
    setPreviewZoom,
    showPreviewPanel,
    vectorData,
    pdfData
  ]);

  useEffect(() => {
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
    if (!pages) return;
    if (viewportAnchorHydratedRef.current) {
      const anchor = captureViewportAnchor(frame);
      viewportAnchorRef.current = anchor;
    }
    const zoom = previewFitMode === "manual" ? previewZoom : deriveFitZoom(frame, pages, previewFitMode);
    applyPreviewZoom(frame, zoom);
    syncPreviewScrollbarWidth(frame);
    restoreViewportAnchor(frame, viewportAnchorRef.current);
    viewportAnchorRef.current = captureViewportAnchor(frame);
    if (viewportAnchorHydratedRef.current) emitViewportAnchor(frame);
    if (previewFitMode !== "manual" && Math.abs(zoom - previewZoom) > FIT_ZOOM_SYNC_EPSILON) {
      setPreviewZoom(zoom);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFitMode, previewRenderTick, previewZoom, ...reflowDeps]);

  useEffect(() => {
    if (!showPreviewPanel) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => {
      syncPreviewScrollbarWidth(frame);
      const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
      if (!pages || previewFitMode === "manual") return;
      if (viewportAnchorHydratedRef.current) {
        viewportAnchorRef.current = captureViewportAnchor(frame);
      }
      const zoom = deriveFitZoom(frame, pages, previewFitMode);
      applyPreviewZoom(frame, zoom);
      syncPreviewScrollbarWidth(frame);
      restoreViewportAnchor(frame, viewportAnchorRef.current);
      viewportAnchorRef.current = captureViewportAnchor(frame);
      if (viewportAnchorHydratedRef.current) emitViewportAnchor(frame);
      setPreviewZoom((current) =>
        Math.abs(current - zoom) > FIT_ZOOM_SYNC_EPSILON ? zoom : current
      );
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [previewFitMode, setPreviewZoom, showPreviewPanel]);

  useEffect(() => {
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const onScroll = () => {
      if (viewportAnchorHydratedRef.current) {
        viewportAnchorRef.current = captureViewportAnchor(frame);
        emitViewportAnchor(frame);
      }
      refreshPageIndicator(frame);
    };
    frame.addEventListener("scroll", onScroll, { passive: true });
    if (viewportAnchorHydratedRef.current) {
      viewportAnchorRef.current = captureViewportAnchor(frame);
      emitViewportAnchor(frame);
    }
    refreshPageIndicator(frame);
    return () => frame.removeEventListener("scroll", onScroll);
  }, [previewRenderTick]);

  useEffect(() => {
    if (!showPreviewPanel) return;
    if (previewFitMode === "manual") return;
    const onResize = () => {
      const frame = canvasPreviewRef.current;
      if (!frame) return;
      syncPreviewScrollbarWidth(frame);
      const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
      if (!pages) return;
      if (viewportAnchorHydratedRef.current) {
        viewportAnchorRef.current = captureViewportAnchor(frame);
      }
      const zoom = deriveFitZoom(frame, pages, previewFitMode);
      applyPreviewZoom(frame, zoom);
      syncPreviewScrollbarWidth(frame);
      restoreViewportAnchor(frame, viewportAnchorRef.current);
      viewportAnchorRef.current = captureViewportAnchor(frame);
      if (viewportAnchorHydratedRef.current) emitViewportAnchor(frame);
      setPreviewZoom((current) =>
        Math.abs(current - zoom) > FIT_ZOOM_SYNC_EPSILON ? zoom : current
      );
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
    viewportAnchorRef.current = captureViewportAnchor(frame);
    emitViewportAnchor(frame);
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
