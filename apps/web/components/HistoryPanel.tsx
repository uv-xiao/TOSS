type Revision = {
  id: string;
  author: string;
  summary: string;
  createdAt: string;
};

export function HistoryPanel({ revisions }: { revisions: Revision[] }) {
  return (
    <div>
      {revisions.map((r) => (
        <div key={r.id} style={{ borderBottom: "1px solid #e5ebf2", padding: "8px 0" }}>
          <strong>{r.summary}</strong>
          <div>{r.author}</div>
          <small>{new Date(r.createdAt).toLocaleString()}</small>
        </div>
      ))}
    </div>
  );
}

