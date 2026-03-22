const LOCALHOSTS = new Set(["localhost", "127.0.0.1"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLocalDevHost() {
  if (typeof window === "undefined") return false;
  return LOCALHOSTS.has(window.location.hostname);
}

function queryParamDevUserId() {
  if (typeof window === "undefined") return "";
  const value = new URLSearchParams(window.location.search).get("dev_user_id");
  if (!value) return "";
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : "";
}

export function resolveDevUserId() {
  const fromQuery = queryParamDevUserId();
  if (fromQuery) return fromQuery;
  const fromEnv = (import.meta.env.VITE_DEV_USER_ID as string | undefined)?.trim() ?? "";
  if (fromEnv) return fromEnv;
  if (isLocalDevHost()) {
    return "00000000-0000-0000-0000-000000000100";
  }
  return "";
}
