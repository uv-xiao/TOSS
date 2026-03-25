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
  hasMore,
  loadingMore,
  onOpenRevision,
  onLoadMore,
  t
}: {
  width: number;
  revisions: Revision[];
  activeRevisionId: string | null;
  loading: boolean;
  loadingRevisionId: string | null;
  loadingBytes: number;
  loadingTotalBytes: number | null;
  hasMore: boolean;
  loadingMore: boolean;
  onOpenRevision: (revisionId: string) => void;
  onLoadMore: () => void;
  t: (key: string) => string;
}) {
  const percent =
    loadingTotalBytes && loadingTotalBytes > 0
      ? Math.max(0, Math.min(100, Math.round((100 * loadingBytes) / loadingTotalBytes)))
      : null;
  const loadingIdText = loadingRevisionId ? `${t("revisions.loadingId")} ${loadingRevisionId.slice(0, 8)}…` : "";
  const loadingBytesText = loadingTotalBytes
    ? `${formatBytes(loadingBytes)} / ${formatBytes(loadingTotalBytes)}`
    : loadingBytes > 0
      ? formatBytes(loadingBytes)
      : "";
  const loadingMeta = [loadingIdText, loadingBytesText].filter(Boolean).join(" · ");

  return (
    <aside className="panel panel-revisions" style={{ width }}>
      <div className="panel-header">
        <h2>{t("workspace.revisions")}</h2>
      </div>
      <div className="panel-content">
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
          loadingRevisionId={loading ? loadingRevisionId : null}
          loadingPercent={loading ? percent : null}
          loadingLabel={t("revisions.loadingSnapshot")}
          loadingMeta={loading ? loadingMeta : ""}
          hasMore={hasMore}
          loadingMore={loadingMore}
          loadingMoreLabel={t("revisions.loadingMore")}
          onLoadMore={onLoadMore}
          onSelect={(revisionId) => {
            if (loading && loadingRevisionId === revisionId) return;
            onOpenRevision(revisionId);
          }}
        />
      </div>
    </aside>
  );
}
