import { HistoryPanel } from "@/components/HistoryPanel";
import type { Revision } from "@/lib/api";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RevisionsPanel({
  width,
  revisions,
  activeRevisionId,
  loading,
  loadingRevisionId,
  loadingBytes,
  loadingTotalBytes,
  onOpenRevision,
  t
}: {
  width: number;
  revisions: Revision[];
  activeRevisionId: string | null;
  loading: boolean;
  loadingRevisionId: string | null;
  loadingBytes: number;
  loadingTotalBytes: number | null;
  onOpenRevision: (revisionId: string) => void;
  t: (key: string) => string;
}) {
  const percent =
    loadingTotalBytes && loadingTotalBytes > 0
      ? Math.max(0, Math.min(100, Math.round((100 * loadingBytes) / loadingTotalBytes)))
      : null;

  return (
    <aside className="panel panel-revisions" style={{ width }}>
      <div className="panel-header">
        <h2>{t("workspace.revisions")}</h2>
      </div>
      <div className="panel-content">
        {loading && (
          <div className="revision-loading">
            <div className="revision-loading-label">
              <strong>{t("revisions.loadingSnapshot")}</strong>
              <span>{percent !== null ? `${percent}%` : t("common.loading")}</span>
            </div>
            <div className="revision-progress">
              <div
                className="revision-progress-fill"
                style={{ width: `${percent !== null ? percent : 15}%` }}
              />
            </div>
            <div className="revision-loading-meta">
              {loadingRevisionId ? `${t("revisions.loadingId")} ${loadingRevisionId.slice(0, 8)}…` : ""}
              {loadingTotalBytes
                ? `${formatBytes(loadingBytes)} / ${formatBytes(loadingTotalBytes)}`
                : loadingBytes > 0
                  ? formatBytes(loadingBytes)
                  : ""}
            </div>
          </div>
        )}
        <HistoryPanel
          revisions={revisions.map((revision) => ({
            id: revision.id,
            summary: revision.summary,
            createdAt: revision.created_at,
            author:
              revision.authors.length > 0
                ? revision.authors.map((author) => author.display_name).join(", ")
                : revision.actor_user_id || "Unknown"
          }))}
          selectedId={activeRevisionId}
          onSelect={(revisionId) => {
            if (loading && loadingRevisionId === revisionId) return;
            onOpenRevision(revisionId);
          }}
        />
      </div>
    </aside>
  );
}
