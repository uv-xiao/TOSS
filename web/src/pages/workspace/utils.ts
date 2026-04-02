import type {
  AssetMeta,
  PreviewFitMode,
  ProjectNode,
  ProjectTreeNodeView,
  WorkspaceLayoutPrefs
} from "@/pages/workspace/types";

export const WORKSPACE_LAYOUT_KEY = "workspace.layout.v2";
export const DEFAULT_LAYOUT_PREFS: WorkspaceLayoutPrefs = {
  filesWidth: 300,
  settingsWidth: 320,
  revisionsWidth: 300,
  editorRatio: 0.56
};
export const MIN_SIDE_PANEL_WIDTH = 220;
export const MAX_SIDE_PANEL_WIDTH = 520;
export const MIN_EDITOR_RATIO = 0.28;
export const MAX_EDITOR_RATIO = 0.72;
export const PREVIEW_MIN_ZOOM = 0.2;
export const PREVIEW_MAX_ZOOM = 5;

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function summarizeContentForHash(content: string) {
  if (content.length <= 96) return content;
  return `${content.slice(0, 48)}::${content.slice(-48)}`;
}

export function buildCompileInputKey(params: {
  entryFilePath: string;
  documents: Array<{ path: string; content: string }>;
  assets: Array<{ path: string; contentBase64: string }>;
  fontData: Uint8Array[];
}) {
  const docsPart = params.documents
    .map((doc) => `${doc.path}:${doc.content.length}:${summarizeContentForHash(doc.content)}`)
    .join("|");
  const assetsPart = params.assets
    .map((asset) => `${asset.path}:${asset.contentBase64.length}:${summarizeContentForHash(asset.contentBase64)}`)
    .join("|");
  const fontsPart = params.fontData
    .map((font) => `${font.byteLength}:${font[0] ?? 0}:${font[Math.floor(font.byteLength / 2)] ?? 0}:${font[font.byteLength - 1] ?? 0}`)
    .join("|");
  return `${params.entryFilePath}::${docsPart}::${assetsPart}::${fontsPart}`;
}

export function buildTopPreviewThumbnail(canvas: HTMLCanvasElement) {
  const srcWidth = Math.max(1, canvas.width || canvas.clientWidth || 1);
  const srcHeight = Math.max(1, canvas.height || canvas.clientHeight || 1);
  const targetRatio = 88 / 54;
  let cropWidth = srcWidth;
  let cropHeight = Math.round(cropWidth / targetRatio);
  if (cropHeight > srcHeight) {
    cropHeight = srcHeight;
    cropWidth = Math.round(cropHeight * targetRatio);
  }
  const cropX = Math.max(0, Math.floor((srcWidth - cropWidth) / 2));
  const cropY = 0;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.min(880, cropWidth));
  out.height = Math.max(1, Math.round(out.width / targetRatio));
  const ctx = out.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#f3f6fb";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

const QUOTED_PATH_REGEX = /"([^"\r\n]+)"/g;
const ABSOLUTE_OR_REMOTE_PATH_REGEX = /^(?:[a-zA-Z]+:|\/)/;

export function collectReferencedAssetPaths(
  docsList: Array<{ path: string; content: string }>,
  assetsByPath: Record<string, AssetMeta>
) {
  const references = new Set<string>();
  for (const doc of docsList) {
    const baseDir = parentProjectPath(doc.path);
    QUOTED_PATH_REGEX.lastIndex = 0;
    let match = QUOTED_PATH_REGEX.exec(doc.content);
    while (match) {
      const quoted = match[1]?.trim() || "";
      if (quoted && !ABSOLUTE_OR_REMOTE_PATH_REGEX.test(quoted) && !quoted.startsWith("#")) {
        const candidatePath = normalizePath(baseDir ? joinProjectPath(baseDir, quoted) : quoted);
        if (candidatePath && assetsByPath[candidatePath]) references.add(candidatePath);
      }
      match = QUOTED_PATH_REGEX.exec(doc.content);
    }
  }
  for (const path of Object.keys(assetsByPath)) {
    if (isFontFile(path)) references.add(path);
  }
  return Array.from(references);
}

export function prependUniqueById<T extends { id: string }>(primary: T[], fallback: T[]) {
  const merged: T[] = [];
  const seen = new Set<string>();
  for (const item of primary) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  for (const item of fallback) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

export function pickWorkspaceOpenPath(
  nodes: ProjectNode[],
  preferredEntryPath: string | null | undefined,
  currentActivePath?: string | null
) {
  const filePaths = nodes.filter((node) => node.kind === "file").map((node) => node.path);
  const fileSet = new Set(filePaths);
  if (currentActivePath && fileSet.has(currentActivePath)) return currentActivePath;
  if (preferredEntryPath && fileSet.has(preferredEntryPath)) return preferredEntryPath;
  return filePaths[0] || preferredEntryPath || "main.typ";
}

export function maxDocumentUpdatedAtIso(
  documents: Array<{ updated_at: string }>,
  currentIso?: string | null
) {
  let maxMs = currentIso ? Date.parse(currentIso) : Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(maxMs)) maxMs = Number.NEGATIVE_INFINITY;
  for (const document of documents) {
    const nextMs = Date.parse(document.updated_at);
    if (Number.isFinite(nextMs) && nextMs > maxMs) maxMs = nextMs;
  }
  if (Number.isFinite(maxMs)) return new Date(maxMs).toISOString();
  return null;
}

export function readWorkspaceLayoutPrefs(): WorkspaceLayoutPrefs {
  if (typeof window === "undefined") return DEFAULT_LAYOUT_PREFS;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT_PREFS;
    const parsed = JSON.parse(raw) as Partial<WorkspaceLayoutPrefs>;
    return {
      filesWidth: clampNumber(parsed.filesWidth ?? DEFAULT_LAYOUT_PREFS.filesWidth, MIN_SIDE_PANEL_WIDTH, MAX_SIDE_PANEL_WIDTH),
      settingsWidth: clampNumber(
        parsed.settingsWidth ?? DEFAULT_LAYOUT_PREFS.settingsWidth,
        MIN_SIDE_PANEL_WIDTH,
        MAX_SIDE_PANEL_WIDTH
      ),
      revisionsWidth: clampNumber(
        parsed.revisionsWidth ?? DEFAULT_LAYOUT_PREFS.revisionsWidth,
        MIN_SIDE_PANEL_WIDTH,
        MAX_SIDE_PANEL_WIDTH
      ),
      editorRatio: clampNumber(parsed.editorRatio ?? DEFAULT_LAYOUT_PREFS.editorRatio, MIN_EDITOR_RATIO, MAX_EDITOR_RATIO)
    };
  } catch {
    return DEFAULT_LAYOUT_PREFS;
  }
}

export function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function normalizePath(path: string) {
  return path.trim().replace(/^\/+/, "");
}

export function joinProjectPath(base: string, leaf: string) {
  const cleanBase = normalizePath(base);
  const cleanLeaf = normalizePath(leaf);
  if (!cleanBase) return cleanLeaf;
  if (!cleanLeaf) return cleanBase;
  return `${cleanBase}/${cleanLeaf}`;
}

export function parentProjectPath(path: string) {
  const clean = normalizePath(path);
  const idx = clean.lastIndexOf("/");
  if (idx < 0) return "";
  return clean.slice(0, idx);
}

export function isTextFile(path: string) {
  return /\.(typ|bib|txt|md|json|toml|yaml|yml|csv|xml|html|css|js|ts|tsx|jsx)$/i.test(path);
}

export function editorLanguageForPath(path: string): "typst" | "markdown" | "plain" {
  if (/\.typ$/i.test(path)) return "typst";
  if (/\.md$/i.test(path)) return "markdown";
  return "plain";
}

export function isFontFile(path: string) {
  return /\.(ttf|otf|woff|woff2)$/i.test(path);
}

function isImageFile(path: string) {
  return /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(path);
}

function isPdfFile(path: string) {
  return /\.pdf$/i.test(path);
}

export function inferContentType(path: string, contentType?: string) {
  if (contentType && contentType.trim()) return contentType;
  if (isPdfFile(path)) return "application/pdf";
  if (/\.svg$/i.test(path)) return "image/svg+xml";
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.gif$/i.test(path)) return "image/gif";
  if (/\.webp$/i.test(path)) return "image/webp";
  return "application/octet-stream";
}

function previewSurfaces(pages: HTMLElement): HTMLElement[] {
  const pageNodes = Array.from(pages.querySelectorAll(".typst-page")) as HTMLElement[];
  if (pageNodes.length > 0) return pageNodes;
  return Array.from(pages.querySelectorAll("canvas")) as HTMLElement[];
}

function previewSurfaceBaseSize(node: HTMLElement) {
  const storedWidth = Number(node.dataset.baseWidth);
  const storedHeight = Number(node.dataset.baseHeight);
  if (storedWidth > 0 && storedHeight > 0) return { width: storedWidth, height: storedHeight };
  if (node instanceof HTMLCanvasElement) {
    const rect = node.getBoundingClientRect();
    const styleWidth = Number.parseFloat(node.style.width || "");
    const styleHeight = Number.parseFloat(node.style.height || "");
    return {
      width: Math.max(1, styleWidth || rect.width || node.clientWidth || node.width || 1),
      height: Math.max(1, styleHeight || rect.height || node.clientHeight || node.height || 1)
    };
  }
  const styleWidth = Number.parseFloat(node.style.width || "");
  const styleHeight = Number.parseFloat(node.style.height || "");
  const rect = node.getBoundingClientRect();
  return {
    width: Math.max(1, styleWidth || rect.width || node.clientWidth || 1),
    height: Math.max(1, styleHeight || rect.height || node.clientHeight || 1)
  };
}

export function deriveFitZoom(frame: HTMLElement, pages: HTMLElement, mode: Exclude<PreviewFitMode, "manual">) {
  const surfaces = previewSurfaces(pages);
  if (surfaces.length === 0) return 1;
  const firstSurface = surfaces[0];
  const size = previewSurfaceBaseSize(firstSurface);
  const baseWidth = size.width;
  const baseHeight = size.height;
  const frameStyle = window.getComputedStyle(frame);
  const pagesStyle = window.getComputedStyle(pages);
  const framePadX =
    Number.parseFloat(frameStyle.paddingLeft || "0") + Number.parseFloat(frameStyle.paddingRight || "0");
  const framePadY =
    Number.parseFloat(frameStyle.paddingTop || "0") + Number.parseFloat(frameStyle.paddingBottom || "0");
  const pagesPadX =
    Number.parseFloat(pagesStyle.paddingLeft || "0") + Number.parseFloat(pagesStyle.paddingRight || "0");
  const pagesPadY =
    Number.parseFloat(pagesStyle.paddingTop || "0") + Number.parseFloat(pagesStyle.paddingBottom || "0");
  const availableWidth = Math.max(1, frame.clientWidth - framePadX - pagesPadX - 2);
  const availableHeight = Math.max(1, frame.clientHeight - framePadY - pagesPadY - 2);
  const widthZoom = availableWidth / baseWidth;
  const fullPageZoom = Math.min(widthZoom, availableHeight / baseHeight);
  const fitZoom = mode === "width" ? widthZoom : fullPageZoom;
  // Small guard band avoids 1px overflow loops from rounding and device-pixel transforms.
  const safeFitZoom = Math.max(0.001, fitZoom * 0.998);
  return clampNumber(safeFitZoom, PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM);
}

export function applyPreviewZoom(frame: HTMLElement, zoom: number) {
  const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
  if (!pages) return;
  const pagesStyle = window.getComputedStyle(pages);
  const pagesPadX =
    Number.parseFloat(pagesStyle.paddingLeft || "0") + Number.parseFloat(pagesStyle.paddingRight || "0");
  const surfaces = previewSurfaces(pages);
  if (surfaces.length === 0) return;
  let widest = 0;
  for (const surface of surfaces) {
    const size = previewSurfaceBaseSize(surface);
    const baseWidth = size.width;
    const baseHeight = size.height;
    const nextWidth = Math.max(1, Math.round(baseWidth * zoom));
    const nextHeight = Math.max(1, Math.round(baseHeight * zoom));
    if (surface.classList.contains("typst-page")) {
      const canvasBaseWidth = Number.parseFloat(surface.dataset.canvasWidth || "");
      const canvasBaseHeight = Number.parseFloat(surface.dataset.canvasHeight || "");
      const transformWrapper = surface.querySelector(":scope > div") as HTMLElement | null;
      if (
        transformWrapper &&
        Number.isFinite(canvasBaseWidth) &&
        canvasBaseWidth > 0 &&
        Number.isFinite(canvasBaseHeight) &&
        canvasBaseHeight > 0
      ) {
        const canvas = transformWrapper.querySelector("canvas") as HTMLCanvasElement | null;
        if (canvas) {
          canvas.style.width = `${Math.max(1, Math.round(canvasBaseWidth))}px`;
          canvas.style.height = `${Math.max(1, Math.round(canvasBaseHeight))}px`;
        }
        transformWrapper.style.transformOrigin = "0 0";
        transformWrapper.style.transform = `scale(${nextWidth / canvasBaseWidth}, ${nextHeight / canvasBaseHeight})`;
      }
    }
    surface.style.width = `${nextWidth}px`;
    surface.style.height = `${nextHeight}px`;
    widest = Math.max(widest, nextWidth);
  }
  pages.style.width = `${Math.max(widest + pagesPadX, 1)}px`;
}

export function pixelPerPtForZoom(mode: PreviewFitMode, zoom: number) {
  const dpr = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
  // Fit modes can have tiny zoom jitter when panel geometry/scrollbars settle.
  // Keep their render density stable to avoid repeated full canvas rerenders.
  if (mode !== "manual") {
    return clampNumber(Math.ceil(dpr * 2.5), 3, 12);
  }
  const safeZoom = clampNumber(Number.isFinite(zoom) ? zoom : 1, PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM);
  const desiredDensity = Math.max(safeZoom * dpr, dpr * 1.5);
  return clampNumber(Math.ceil(desiredDensity), 3, 12);
}

export function isImageAsset(path: string, contentType?: string) {
  return (contentType || "").startsWith("image/") || isImageFile(path);
}

export function isPdfAsset(path: string, contentType?: string) {
  return (contentType || "").toLowerCase() === "application/pdf" || isPdfFile(path);
}

export function presenceColor(userId: string) {
  const palette = ["#1f5f8c", "#156f43", "#7e3b9f", "#8e5a17", "#8a234b"];
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

export function expandAncestors(path: string, previous: Set<string>) {
  const next = new Set(previous);
  next.add("");
  const clean = normalizePath(path);
  const parts = clean.split("/").filter(Boolean);
  let acc = "";
  for (const part of parts.slice(0, -1)) {
    acc = acc ? `${acc}/${part}` : part;
    next.add(acc);
  }
  return next;
}

export function projectTreeFromFlat(nodes: ProjectNode[]) {
  const root: ProjectTreeNodeView = {
    name: "",
    path: "",
    kind: "directory",
    children: []
  };
  const byPath = new Map<string, ProjectTreeNodeView>();
  byPath.set("", root);

  const normalized = [...nodes].sort((a, b) => a.path.localeCompare(b.path));
  for (const node of normalized) {
    const path = normalizePath(node.path);
    const parts = path.split("/");
    let parentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const currentPath = parentPath ? `${parentPath}/${part}` : part;
      const isLeaf = i === parts.length - 1;
      const kind: "file" | "directory" = isLeaf ? node.kind : "directory";
      if (!byPath.has(currentPath)) {
        const entry: ProjectTreeNodeView = {
          name: part,
          path: currentPath,
          kind,
          children: []
        };
        byPath.set(currentPath, entry);
        byPath.get(parentPath)?.children.push(entry);
      }
      parentPath = currentPath;
    }
  }
  const sortTree = (items: ProjectTreeNodeView[]) => {
    items.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const item of items) sortTree(item.children);
  };
  sortTree(root.children);
  return root.children;
}
