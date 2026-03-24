import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

export function ShareJoinPage({
  t,
  onJoin
}: {
  t: (key: string) => string;
  onJoin: (token: string) => Promise<{ project_id: string }>;
}) {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    onJoin(token)
      .then((joined) => {
        if (cancelled) return;
        navigate(`/project/${joined.project_id}`, { replace: true });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t("share.joinFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, onJoin, t, token]);

  return (
    <section className="page">
      <div className="card">
        <strong>{t("share.joining")}</strong>
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}

