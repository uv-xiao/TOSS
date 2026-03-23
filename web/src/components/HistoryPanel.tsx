type Revision = {
  id: string;
  author: string;
  summary: string;
  createdAt: string;
};

export function HistoryPanel({
  revisions,
  selectedId,
  onSelect
}: {
  revisions: Revision[];
  selectedId?: string | null;
  onSelect?: (revisionId: string) => void;
}) {
  return (
    <div className="history-list">
      {revisions.map((r) => (
        <button
          key={r.id}
          className={`history-item ${selectedId === r.id ? "active" : ""}`}
          onClick={() => onSelect?.(r.id)}
        >
          <strong>{r.summary}</strong>
          <div>{r.author}</div>
          <small>{new Date(r.createdAt).toLocaleString()}</small>
        </button>
      ))}
    </div>
  );
}
