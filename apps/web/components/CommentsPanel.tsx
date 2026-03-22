type Comment = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
};

export function CommentsPanel({ comments }: { comments: Comment[] }) {
  return (
    <div>
      {comments.map((c) => (
        <div key={c.id} style={{ borderBottom: "1px solid #e5ebf2", padding: "8px 0" }}>
          <strong>{c.author}</strong>
          <div>{c.body}</div>
          <small>{new Date(c.createdAt).toLocaleString()}</small>
        </div>
      ))}
    </div>
  );
}

