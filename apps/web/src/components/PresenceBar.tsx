type PresenceUser = {
  id: string;
  name: string;
  color: string;
};

export function PresenceBar({ users }: { users: PresenceUser[] }) {
  return (
    <div className="meta">
      {users.map((u) => (
        <span key={u.id} style={{ color: u.color }}>
          {u.name}
        </span>
      ))}
    </div>
  );
}

