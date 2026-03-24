import { Download } from "lucide-react";

export function UnsupportedFilePane({
  path,
  hasData,
  isImage,
  isPdf,
  dataUrl,
  t
}: {
  path: string;
  hasData: boolean;
  isImage: boolean;
  isPdf: boolean;
  dataUrl: string;
  t: (key: string) => string;
}) {
  const downloadName = path.split("/").filter(Boolean).pop() || path;
  const media = isImage ? (
    <img src={dataUrl} alt={path} className="file-preview-image" />
  ) : isPdf ? (
    <iframe title={path} src={dataUrl} className="file-preview-pdf" />
  ) : (
    <div className="file-icon" aria-hidden />
  );

  if (!hasData) {
    return (
      <div className="file-preview file-preview-asset">
        <div className="file-preview-media">
          <div className="file-icon" aria-hidden />
        </div>
        <div className="file-preview-meta">
          <div className="file-preview-name">{path}</div>
          <small>File content is loading.</small>
        </div>
      </div>
    );
  }

  return (
    <div className="file-preview file-preview-asset">
      <div className="file-preview-media">{media}</div>
      <div className="file-preview-meta">
        <div className="file-preview-name">{downloadName}</div>
        <small className="muted">{path}</small>
        <a
          className="ui-icon-button"
          href={dataUrl}
          download={downloadName}
          title={t("workspace.download")}
          aria-label={t("workspace.download")}
        >
          <Download size={16} />
        </a>
      </div>
    </div>
  );
}

