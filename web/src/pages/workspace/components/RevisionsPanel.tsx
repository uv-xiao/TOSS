import { HistoryPanel } from "@/components/HistoryPanel";
import type { Revision } from "@/lib/api";

export function RevisionsPanel({
  width,
  revisions,
  activeRevisionId,
  onOpenRevision,
  t
}: {
  width: number;
  revisions: Revision[];
  activeRevisionId: string | null;
  onOpenRevision: (revisionId: string) => void;
  t: (key: string) => string;
}) {
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
          onSelect={onOpenRevision}
        />
      </div>
    </aside>
  );
}

