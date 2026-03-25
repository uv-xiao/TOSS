import { useEffect, useRef, type UIEvent } from "react";

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
  hasMore,
  loadingMore,
  loadingMoreLabel,
  onLoadMore,
  onSelect
}: {
  revisions: Revision[];
  selectedId?: string | null;
  loadingRevisionId?: string | null;
  loadingPercent?: number | null;
  loadingLabel?: string;
  loadingMeta?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  loadingMoreLabel?: string;
  onLoadMore?: () => void;
  onSelect?: (revisionId: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore || loadingMore || !onLoadMore) return;
    const element = listRef.current;
    if (!element) return;
    if (element.scrollHeight <= element.clientHeight + 8) {
      onLoadMore();
    }
  }, [hasMore, loadingMore, onLoadMore, revisions.length]);

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    if (!hasMore || loadingMore || !onLoadMore) return;
    const element = event.currentTarget;
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 96) {
      onLoadMore();
    }
  }

  return (
    <div className="history-list" onScroll={handleScroll} ref={listRef}>
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
      {loadingMore ? <div className="history-list-more">{loadingMoreLabel || "Loading..."}</div> : null}
    </div>
  );
}
