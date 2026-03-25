import { useEffect, useState } from "react";
import { UiButton, UiInput, UiSelect } from "@/components/ui";
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
  type PersonalAccessTokenInfo
} from "@/lib/api";

export function ProfilePage({ t }: { t: (key: string) => string }) {
  type CreatePatReveal = {
    token: string;
    token_prefix: string;
    label: string;
    expires_at?: string | null;
    created_at?: string;
  };

  const [tokens, setTokens] = useState<PersonalAccessTokenInfo[]>([]);
  const [tokenLabel, setTokenLabel] = useState("CLI token");
  const [tokenExpiryPreset, setTokenExpiryPreset] = useState<"never" | "7d" | "30d" | "90d" | "custom">("30d");
  const [tokenCustomExpiresAtLocal, setTokenCustomExpiresAtLocal] = useState("");
  const [newToken, setNewToken] = useState<CreatePatReveal | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyTokenId, setBusyTokenId] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await listPersonalAccessTokens();
      setTokens(res.tokens);
      setError(null);
    } catch (err) {
      setTokens([]);
      setError(err instanceof Error ? err.message : t("profile.loadFailed"));
    }
  }

  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);

  function formatOptionalDate(value: string | null) {
    if (!value) return t("profile.never");
    return new Date(value).toLocaleString();
  }

  function computeExpiresAt(): string | null {
    if (tokenExpiryPreset === "never") return null;
    if (tokenExpiryPreset === "custom") {
      if (!tokenCustomExpiresAtLocal.trim()) return null;
      const parsed = new Date(tokenCustomExpiresAtLocal);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(t("profile.invalidExpiry"));
      }
      return parsed.toISOString();
    }
    const days = tokenExpiryPreset === "7d" ? 7 : tokenExpiryPreset === "30d" ? 30 : 90;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  async function createToken() {
    if (!tokenLabel.trim()) return;
    try {
      setCreating(true);
      setError(null);
      const created = await createPersonalAccessToken({
        label: tokenLabel.trim(),
        expires_at: computeExpiresAt()
      });
      setNewToken({
        token: created.token,
        token_prefix: created.token_prefix,
        label: created.label,
        expires_at: created.expires_at,
        created_at: created.created_at
      });
      setCopiedToken(false);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("profile.createFailed");
      setError(message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="page profile-page">
      <h2>{t("profile.title")}</h2>
      <div className="card-list">
        <div className="card profile-token-create">
          <strong>{t("profile.tokensTitle")}</strong>
          <span className="muted">
            {t("profile.tokensHint")}
          </span>
          <div className="profile-token-form">
            <label>
              <span>{t("profile.tokenLabel")}</span>
              <UiInput
                value={tokenLabel}
                onChange={(e) => setTokenLabel(e.target.value)}
                placeholder={t("profile.tokenLabelPlaceholder")}
              />
            </label>
            <label>
              <span>{t("profile.expires")}</span>
              <UiSelect
                value={tokenExpiryPreset}
                onChange={(e) =>
                  setTokenExpiryPreset(e.target.value as "never" | "7d" | "30d" | "90d" | "custom")
                }
              >
                <option value="never">{t("profile.expNever")}</option>
                <option value="7d">{t("profile.exp7d")}</option>
                <option value="30d">{t("profile.exp30d")}</option>
                <option value="90d">{t("profile.exp90d")}</option>
                <option value="custom">{t("profile.expCustom")}</option>
              </UiSelect>
            </label>
            {tokenExpiryPreset === "custom" && (
              <label>
                <span>{t("profile.customExpiry")}</span>
                <UiInput
                  type="datetime-local"
                  value={tokenCustomExpiresAtLocal}
                  onChange={(e) => setTokenCustomExpiresAtLocal(e.target.value)}
                />
              </label>
            )}
          </div>
          <div className="toolbar">
            <UiButton variant="primary" onClick={createToken} disabled={creating || !tokenLabel.trim()}>
              {creating ? t("profile.creating") : t("profile.createToken")}
            </UiButton>
          </div>
        </div>
        {newToken && (
          <div className="card profile-new-token">
            <strong>{t("profile.newTokenShownOnce")}</strong>
            <div className="token-reveal">{newToken.token}</div>
            <div className="toolbar">
              <UiButton
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(newToken.token);
                  setCopiedToken(true);
                  window.setTimeout(() => setCopiedToken(false), 1200);
                }}
              >
                {copiedToken ? t("share.copied") : t("profile.copyToken")}
              </UiButton>
            </div>
            <small className="muted">
              {t("profile.tokenLabel")}: {newToken.label} · {t("profile.prefix")}: {newToken.token_prefix} ·{" "}
              {t("profile.expires")}: {formatOptionalDate(newToken.expires_at || null)}
            </small>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="card">
          <strong>{t("profile.tokenList")}</strong>
          <div className="card-list">
            {tokens.map((token) => (
              <div className="card" key={token.id}>
                <strong>{token.label}</strong>
                <span>{t("profile.prefix")}: {token.token_prefix}</span>
                <span>{t("profile.created")}: {new Date(token.created_at).toLocaleString()}</span>
                <span>{t("profile.expires")}: {formatOptionalDate(token.expires_at)}</span>
                <span>{t("profile.lastUsed")}: {formatOptionalDate(token.last_used_at)}</span>
                <span>
                  {t("profile.status")}:{" "}
                  {token.revoked_at
                    ? `${t("profile.statusRevokedAt")} ${formatOptionalDate(token.revoked_at)}`
                    : t("profile.statusActive")}
                </span>
                <div className="toolbar">
                  <UiButton
                    size="sm"
                    onClick={async () => {
                      await navigator.clipboard.writeText(token.token_prefix);
                    }}
                  >
                    {t("profile.copyPrefix")}
                  </UiButton>
                  <UiButton
                    size="sm"
                    disabled={!!token.revoked_at || busyTokenId === token.id}
                    onClick={async () => {
                      try {
                        setBusyTokenId(token.id);
                        await revokePersonalAccessToken(token.id);
                        await refresh();
                      } finally {
                        setBusyTokenId(null);
                      }
                    }}
                  >
                    {token.revoked_at ? t("profile.revoked") : t("common.revoke")}
                  </UiButton>
                </div>
              </div>
            ))}
            {tokens.length === 0 && <div className="card muted">{t("profile.noTokens")}</div>}
          </div>
        </div>
      </div>
    </section>
  );
}
