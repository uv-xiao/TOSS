type PresenceUser = {
  id: string;
  name: string;
  color: string;
  line?: number;
  column?: number;
};

export function PresenceBar({ users }: { users: PresenceUser[] }) {
  return (
    <div className="meta">
      {users.map((u) => (
        <span key={u.id} style={{ color: u.color }}>
          {u.name}
          {u.line && u.column ? ` (L${u.line}:C${u.column})` : ""}
        </span>
      ))}
    </div>
  );
}
