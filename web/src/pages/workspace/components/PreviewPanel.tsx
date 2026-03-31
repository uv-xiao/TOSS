import { ArrowLeftRight, Download, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { UiIconButton } from "@/components/ui";
import type { CompileDiagnostic, TypstRuntimeStatus } from "@/lib/typst";

export function PreviewPanel({
  editorRatio,
  previewFitMode,
  previewPercent,
  pdfData,
  typstRuntimeStatus,
  workspaceSyncPending,
  assetHydrationProgress,
  vectorData,
  previewIsPanning,
  compileDiagnostics,
  compileErrors,
  hasPreviewPage,
  canvasPreviewRef,
  onBeginPreviewPan,
  onSetFitWholePage,
  onSetFitPageWidth,
  onDecreaseZoom,
  onIncreaseZoom,
  onDownloadPdf,
  onJumpToDiagnostic,
  t
}: {
  editorRatio: number;
  previewFitMode: "manual" | "page" | "width";
  previewPercent: number;
  pdfData: Uint8Array | null;
  typstRuntimeStatus: TypstRuntimeStatus;
  workspaceSyncPending: boolean;
  assetHydrationProgress: {
    active: boolean;
    loaded: number;
    total: number;
    loadedBytes: number;
    totalBytes: number;
  };
  vectorData: Uint8Array | null;
  previewIsPanning: boolean;
  compileDiagnostics: CompileDiagnostic[];
  compileErrors: string[];
  hasPreviewPage: boolean;
  canvasPreviewRef: React.RefObject<HTMLDivElement | null>;
  onBeginPreviewPan: (event: React.MouseEvent<HTMLDivElement>) => void;
  onSetFitWholePage: () => void;
  onSetFitPageWidth: () => void;
  onDecreaseZoom: () => void;
  onIncreaseZoom: () => void;
  onDownloadPdf: () => void;
  onJumpToDiagnostic: (diagnostic: CompileDiagnostic) => void;
  t: (key: string) => string;
}) {
  const hasCompileFailure = compileDiagnostics.length > 0 || compileErrors.length > 0;
  const showStaleOverlay = hasCompileFailure && hasPreviewPage;
  const showEmptyErrorState = hasCompileFailure && !hasPreviewPage;

  return (
    <aside className="panel panel-preview" style={{ flex: `${1 - editorRatio} 1 0`, minWidth: 280 }}>
      <div className="panel-header workspace-main-header">
        <h2>{t("workspace.preview")}</h2>
        <div className="toolbar compact">
          <UiIconButton
            tooltip={t("preview.fitWhole")}
            label={t("preview.fitWhole")}
            className={previewFitMode === "page" ? "active" : ""}
            onClick={onSetFitWholePage}
          >
            <Maximize2 size={16} />
          </UiIconButton>
          <UiIconButton
            tooltip={t("preview.fitWidth")}
            label={t("preview.fitWidth")}
            className={previewFitMode === "width" ? "active" : ""}
            onClick={onSetFitPageWidth}
          >
            <ArrowLeftRight size={16} />
          </UiIconButton>
          <UiIconButton tooltip={t("preview.zoomOut")} label={t("preview.zoomOut")} onClick={onDecreaseZoom}>
            <ZoomOut size={16} />
          </UiIconButton>
          <span className="zoom-indicator">{previewPercent}%</span>
          <UiIconButton tooltip={t("preview.zoomIn")} label={t("preview.zoomIn")} onClick={onIncreaseZoom}>
            <ZoomIn size={16} />
          </UiIconButton>
          <UiIconButton
            tooltip={t("preview.downloadPdf")}
            label={t("preview.downloadPdf")}
            onClick={onDownloadPdf}
            disabled={!pdfData}
          >
            <Download size={16} />
          </UiIconButton>
        </div>
      </div>
      <div className="panel-content flush preview-panel-content">
        {workspaceSyncPending && (
          <div className="preview-runtime-status">
            <strong>{t("preview.loadingProject")}</strong>
          </div>
        )}
        {assetHydrationProgress.active && (
          <div className="preview-runtime-status">
            <strong>
              {t("preview.loadingProjectAssets")
                .replace("{loaded}", String(assetHydrationProgress.loaded))
                .replace("{total}", String(assetHydrationProgress.total))}
            </strong>
            <span>
              {assetHydrationProgress.totalBytes > 0
                ? `${Math.round((100 * assetHydrationProgress.loadedBytes) / assetHydrationProgress.totalBytes)}%`
                : `${assetHydrationProgress.loaded}/${assetHydrationProgress.total}`}
            </span>
          </div>
        )}
        {(typstRuntimeStatus.stage === "downloading-compiler" ||
          (typstRuntimeStatus.stage === "compiling" && !vectorData)) && (
          <div className="preview-runtime-status">
            <strong>
              {typstRuntimeStatus.stage === "downloading-compiler"
                ? t("preview.loadingCompiler")
                : t("preview.compiling")}
            </strong>
            {typstRuntimeStatus.stage === "downloading-compiler" && (
              <span>
                {typstRuntimeStatus.totalBytes && typstRuntimeStatus.totalBytes > 0
                  ? `${Math.round((100 * (typstRuntimeStatus.loadedBytes || 0)) / typstRuntimeStatus.totalBytes)}%`
                  : `${Math.round((typstRuntimeStatus.loadedBytes || 0) / 1024)} KB`}
              </span>
            )}
          </div>
        )}
        <div className="preview-stage">
          <div
            ref={canvasPreviewRef}
            className={`pdf-frame preview-fit-${previewFitMode} ${previewIsPanning ? "is-panning" : ""}`}
            onMouseDown={onBeginPreviewPan}
          />
          {showStaleOverlay && (
            <div className="preview-stale-overlay">
              <strong>{t("preview.staleTitle")}</strong>
              <span>{t("preview.staleHint")}</span>
            </div>
          )}
          {showEmptyErrorState && (
            <div className="preview-empty-error">
              <strong>{t("preview.failedTitle")}</strong>
              <span>{t("preview.failedHint")}</span>
            </div>
          )}
        </div>
        {compileDiagnostics.length > 0 && (
          <div className="panel-inline-error diagnostics">
            {compileDiagnostics.map((diagnostic, index) => (
              <button
                key={`${diagnostic.raw}-${index}`}
                className="diagnostic-item"
                onClick={() => onJumpToDiagnostic(diagnostic)}
              >
                <span className={`diagnostic-level ${diagnostic.severity}`}>{diagnostic.severity}</span>
                <span className="diagnostic-main">
                  {diagnostic.path ? `${diagnostic.path}:${diagnostic.line ?? 1}:${diagnostic.column ?? 1}` : "workspace"}
                  {" — "}
                  {diagnostic.message}
                </span>
              </button>
            ))}
          </div>
        )}
        {compileDiagnostics.length === 0 && compileErrors.length > 0 && (
          <div className="error panel-inline-error">{compileErrors.join("; ")}</div>
        )}
      </div>
    </aside>
  );
}
