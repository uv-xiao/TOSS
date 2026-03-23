type CachedNode = { path: string; kind: "file" | "directory" };

type CachedProjectSnapshot = {
  projectId: string;
  entryFilePath: string;
  nodes: CachedNode[];
  docs: Record<string, string>;
  cachedAt: number;
};

const CACHE_PREFIX = "typst.project.cache.";
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PROJECT_CACHE_COUNT = 20;
const MAX_SNAPSHOT_BYTES = 2_000_000;

function cacheKey(projectId: string) {
  return `${CACHE_PREFIX}${projectId}`;
}

function allCacheKeys() {
  if (typeof window === "undefined") return [] as string[];
  const out: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith(CACHE_PREFIX)) out.push(key);
  }
  return out;
}

function pruneCaches() {
  if (typeof window === "undefined") return;
  const now = Date.now();
  const entries: Array<{ key: string; cachedAt: number }> = [];
  for (const key of allCacheKeys()) {
    const raw = window.localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as CachedProjectSnapshot;
      if (!parsed.cachedAt || now - parsed.cachedAt > CACHE_TTL_MS) {
        window.localStorage.removeItem(key);
        continue;
      }
      entries.push({ key, cachedAt: parsed.cachedAt });
    } catch {
      window.localStorage.removeItem(key);
    }
  }
  entries.sort((a, b) => b.cachedAt - a.cachedAt);
  for (let i = MAX_PROJECT_CACHE_COUNT; i < entries.length; i += 1) {
    window.localStorage.removeItem(entries[i].key);
  }
}

export function loadProjectSnapshotFromCache(projectId: string): CachedProjectSnapshot | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(cacheKey(projectId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedProjectSnapshot;
    if (!parsed.cachedAt || Date.now() - parsed.cachedAt > CACHE_TTL_MS) {
      window.localStorage.removeItem(cacheKey(projectId));
      return null;
    }
    return parsed;
  } catch {
    window.localStorage.removeItem(cacheKey(projectId));
    return null;
  }
}

export function saveProjectSnapshotToCache(input: {
  projectId: string;
  entryFilePath: string;
  nodes: CachedNode[];
  docs: Record<string, string>;
}) {
  if (typeof window === "undefined") return;
  const snapshot: CachedProjectSnapshot = {
    projectId: input.projectId,
    entryFilePath: input.entryFilePath,
    nodes: input.nodes,
    docs: input.docs,
    cachedAt: Date.now()
  };
  const serialized = JSON.stringify(snapshot);
  if (serialized.length > MAX_SNAPSHOT_BYTES) return;
  try {
    window.localStorage.setItem(cacheKey(input.projectId), serialized);
    pruneCaches();
  } catch {
    // ignore quota errors and continue with normal online workflow
  }
}
