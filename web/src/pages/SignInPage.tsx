import { AuthForm } from "@/components/AuthForm";
import type { AuthConfig } from "@/lib/api";

export function SignInPage({
  config,
  t,
  onSignedIn
}: {
  config: AuthConfig | null;
  t: (key: string) => string;
  onSignedIn: () => Promise<void>;
}) {
  return (
    <section className="auth-shell">
      <div className="auth-card">
        <h2>{t("auth.signIn")}</h2>
        <p>{t("auth.subtitle")}</p>
        <AuthForm config={config} t={t} onSignedIn={onSignedIn} />
      </div>
    </section>
  );
}
