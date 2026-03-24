type Revision = {
  id: string;
  author: string;
  summary: string;
  createdAt: string;
};

export function HistoryPanel({
  revisions,
  selectedId,
  loadingRevisionId,
  loadingPercent,
  loadingLabel,
  loadingMeta,
  onSelect
}: {
  revisions: Revision[];
  selectedId?: string | null;
  loadingRevisionId?: string | null;
  loadingPercent?: number | null;
  loadingLabel?: string;
  loadingMeta?: string;
  onSelect?: (revisionId: string) => void;
}) {
  return (
    <div className="history-list">
      {revisions.map((r) => {
        const isLoading = loadingRevisionId === r.id;
        return (
          <button
            key={r.id}
            className={`history-item ${selectedId === r.id ? "active" : ""} ${isLoading ? "loading" : ""}`}
            onClick={() => onSelect?.(r.id)}
            aria-busy={isLoading ? "true" : "false"}
          >
            <strong>{r.summary}</strong>
            <div>{r.author}</div>
            <small>{new Date(r.createdAt).toLocaleString()}</small>
            {isLoading && (
              <div className="history-item-loading">
                <div className="history-item-loading-label">
                  <span>{loadingLabel || "Loading..."}</span>
                  <span>{loadingPercent !== null && loadingPercent !== undefined ? `${loadingPercent}%` : ""}</span>
                </div>
                <div className="history-item-progress">
                  <div
                    className="history-item-progress-fill"
                    style={{ width: `${loadingPercent !== null && loadingPercent !== undefined ? loadingPercent : 15}%` }}
                  />
                </div>
                {loadingMeta ? <small>{loadingMeta}</small> : null}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
