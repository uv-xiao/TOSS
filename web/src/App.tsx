import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import * as Y from "yjs";
import { EditorPane, type EditorChange } from "@/components/EditorPane";
import { HistoryPanel } from "@/components/HistoryPanel";
import {
  UiBadge,
  UiButton,
  UiCard,
  UiDialog,
  UiIconButton,
  UiInput,
  UiSelect
} from "@/components/ui";
import { bindRealtimeYDoc, type PresencePeer, type RealtimeStatus } from "@/lib/realtime";
import {
  compileTypstClientSide,
  renderTypstVectorToCanvas,
  subscribeTypstRuntimeStatus,
  type CompileDiagnostic,
  type TypstRuntimeStatus
} from "@/lib/typst";
import {
  createPersonalAccessToken,
  createProject,
  copyProject,
  createProjectShareLink,
  createProjectFile,
  deleteProjectTemplateOrganizationAccess,
  deleteProjectOrganizationAccess,
  downloadProjectArchive,
  deleteOrgGroupRoleMapping,
  deleteProjectFile,
  getAdminAuthSettings,
  getAuthConfig,
  getAuthMe,
  getGitRepoLink,
  getProjectAssetContent,
  getProjectSettings,
  projectThumbnailUrl,
  getProjectTree,
  getRevisionDocuments,
  listDocuments,
  listMyOrganizations,
  listOrgGroupRoleMappings,
  listPersonalAccessTokens,
  listProjectAccessUsers,
  listProjectAssets,
  listProjectOrganizationAccess,
  listProjectTemplateOrganizationAccess,
  listProjectShareLinks,
  listProjects,
  listRevisions,
  joinProjectShareLink,
  localLogin,
  localRegister,
  logout,
  oidcLoginUrl,
  revokeProjectShareLink,
  revokePersonalAccessToken,
  setProjectArchived,
  updateProjectTemplate,
  type AdminAuthSettings,
  type AuthConfig,
  type AuthUser,
  type OrganizationMembership,
  type OrgGroupRoleMapping,
  type PersonalAccessTokenInfo,
  type Project,
  type ProjectAccessUser,
  type ProjectOrganizationAccess,
  type ProjectRole,
  type ProjectTemplateOrganizationAccess,
  type ProjectShareLink,
  type Revision,
  moveProjectFile,
  upsertAdminAuthSettings,
  upsertDocumentByPath,
  upsertOrgGroupRoleMapping,
  upsertProjectOrganizationAccess,
  upsertProjectTemplateOrganizationAccess,
  upsertProjectSettings,
  uploadProjectThumbnail,
  uploadProjectAsset
} from "@/lib/api";
import { readStoredLocale, translate, type UiLocale } from "@/lib/i18n";
import { loadProjectSnapshotFromCache, saveProjectSnapshotToCache } from "@/lib/projectCache";
import { AdminPage } from "@/pages/AdminPage";
import { ProfilePage } from "@/pages/ProfilePage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { SignInPage } from "@/pages/SignInPage";
import type { ProjectCopyDialogState } from "@/types/project-ui";
import {
  Archive,
  ArrowRight,
  Copy,
  Download,
  FilePlus2,
  FolderPlus,
  Plus,
  RefreshCw,
  Upload,
  ZoomIn,
  ZoomOut
} from "lucide-react";

type ProjectTreeNodeView = {
  name: string;
  path: string;
  kind: "file" | "directory";
  children: ProjectTreeNodeView[];
};

type AssetMeta = {
  id?: string;
  contentType: string;
};

type ContextMenuState = {
  path: string;
  kind: "file" | "directory";
  x: number;
  y: number;
};

type PathDialogState =
  | {
      mode: "create";
      kind: "file" | "directory";
      parentPath: string;
      value: string;
    }
  | {
      mode: "rename";
      path: string;
      value: string;
    }
  | {
      mode: "delete";
      path: string;
    };

type WorkspaceLayoutPrefs = {
  filesWidth: number;
  settingsWidth: number;
  revisionsWidth: number;
  editorRatio: number;
};

const WORKSPACE_LAYOUT_KEY = "workspace.layout.v2";
const DEFAULT_LAYOUT_PREFS: WorkspaceLayoutPrefs = {
  filesWidth: 300,
  settingsWidth: 320,
  revisionsWidth: 300,
  editorRatio: 0.56
};
const MIN_SIDE_PANEL_WIDTH = 220;
const MAX_SIDE_PANEL_WIDTH = 520;
const MIN_EDITOR_RATIO = 0.28;
const MAX_EDITOR_RATIO = 0.72;
const PREVIEW_MIN_ZOOM = 0.2;
const PREVIEW_MAX_ZOOM = 5;

type PreviewFitMode = "manual" | "page" | "width";

const WorkspaceTopbarContext = createContext<(content: ReactNode | null) => void>(() => undefined);

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readWorkspaceLayoutPrefs(): WorkspaceLayoutPrefs {
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

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function normalizePath(path: string) {
  return path.trim().replace(/^\/+/, "");
}

function joinProjectPath(base: string, leaf: string) {
  const cleanBase = normalizePath(base);
  const cleanLeaf = normalizePath(leaf);
  if (!cleanBase) return cleanLeaf;
  if (!cleanLeaf) return cleanBase;
  return `${cleanBase}/${cleanLeaf}`;
}

function parentProjectPath(path: string) {
  const clean = normalizePath(path);
  const idx = clean.lastIndexOf("/");
  if (idx < 0) return "";
  return clean.slice(0, idx);
}

function isTextFile(path: string) {
  return /\.(typ|txt|md|json|toml|yaml|yml|csv|xml|html|css|js|ts|tsx|jsx)$/i.test(path);
}

function editorLanguageForPath(path: string): "typst" | "markdown" | "plain" {
  if (/\.typ$/i.test(path)) return "typst";
  if (/\.md$/i.test(path)) return "markdown";
  return "plain";
}

function isFontFile(path: string) {
  return /\.(ttf|otf|woff|woff2)$/i.test(path);
}

function isImageFile(path: string) {
  return /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(path);
}

function isPdfFile(path: string) {
  return /\.pdf$/i.test(path);
}

function inferContentType(path: string, contentType?: string) {
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

function deriveFitZoom(frame: HTMLElement, pages: HTMLElement, mode: Exclude<PreviewFitMode, "manual">) {
  const surfaces = previewSurfaces(pages);
  if (surfaces.length === 0) return 1;
  const firstSurface = surfaces[0];
  const size = previewSurfaceBaseSize(firstSurface);
  const baseWidth = size.width;
  const baseHeight = size.height;
  const widthZoom = (frame.clientWidth - 20) / baseWidth;
  const fullPageZoom = Math.min(widthZoom, (frame.clientHeight - 20) / baseHeight);
  return clampNumber(mode === "width" ? widthZoom : fullPageZoom, PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM);
}

function applyPreviewZoom(frame: HTMLElement, zoom: number) {
  const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
  if (!pages) return;
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
  pages.style.width = `${Math.max(widest, 1)}px`;
}

function pixelPerPtForZoom(mode: PreviewFitMode, zoom: number) {
  if (mode !== "manual") return 2;
  const dpr = typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
  return clampNumber(Math.ceil(zoom * dpr), 2, 12);
}

function isImageAsset(path: string, contentType?: string) {
  return (contentType || "").startsWith("image/") || isImageFile(path);
}

function isPdfAsset(path: string, contentType?: string) {
  return (contentType || "").toLowerCase() === "application/pdf" || isPdfFile(path);
}

function presenceColor(userId: string) {
  const palette = ["#1f5f8c", "#156f43", "#7e3b9f", "#8e5a17", "#8a234b"];
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

function expandAncestors(path: string, previous: Set<string>) {
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

function projectTreeFromFlat(nodes: { path: string; kind: "file" | "directory" }[]) {
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

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [authLoading, setAuthLoading] = useState(true);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const locale: UiLocale = useMemo(() => readStoredLocale(), []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationMembership[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [workspaceTopbar, setWorkspaceTopbar] = useState<ReactNode | null>(null);
  const onWorkspaceRoute = location.pathname.startsWith("/project/");
  const onProjectsRoute = location.pathname === "/projects" || location.pathname === "/";
  const onProfileRoute = location.pathname.startsWith("/profile");
  const onAdminRoute = location.pathname.startsWith("/admin");
  const hasOrgAdminAccess = organizations.some((org) => org.is_admin);
  const shareTokenFromPath = location.pathname.startsWith("/share/")
    ? decodeURIComponent(location.pathname.replace("/share/", ""))
    : null;
  const t = useMemo(() => (key: string) => translate(locale, key), [locale]);

  useEffect(() => {
    if (!shareTokenFromPath) return;
    window.sessionStorage.setItem("share.token.pending", shareTokenFromPath);
  }, [shareTokenFromPath]);

  useEffect(() => {
    Promise.all([getAuthConfig(), getAuthMe()])
      .then(([cfg, me]) => {
        setAuthConfig(cfg);
        setAuthUser(me);
      })
      .catch(() => {
        setAuthConfig(null);
        setAuthUser(null);
      })
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!authUser) {
      setProjects([]);
      setOrganizations([]);
      return;
    }
    Promise.all([listProjects({ includeArchived: true }), listMyOrganizations()])
      .then(([res, orgs]) => {
        setProjects(res.projects);
        setOrganizations(orgs.organizations);
        setError(null);
      })
      .catch((err) => {
        setProjects([]);
        setOrganizations([]);
        setError(err instanceof Error ? err.message : "Unable to load projects");
      });
  }, [authUser?.user_id]);

  useEffect(() => {
    if (!onWorkspaceRoute && workspaceTopbar) {
      setWorkspaceTopbar(null);
    }
  }, [onWorkspaceRoute, workspaceTopbar]);

  const firstProject = projects.find((project) => !project.archived)?.id ?? projects[0]?.id;
  const siteName = authConfig?.site_name?.trim() || t("brand.name");

  async function handleLogout() {
    await logout();
    setAuthUser(null);
    setProjects([]);
    setOrganizations([]);
  }

  async function refreshProjects() {
    if (!authUser) return;
    const [next, orgs] = await Promise.all([listProjects({ includeArchived: true }), listMyOrganizations()]);
    setProjects(next.projects);
    setOrganizations(orgs.organizations);
  }

  if (authLoading) return <main className="loading">Loading...</main>;

  if (!authUser) {
    return (
      <SignInPage
        config={authConfig}
        t={t}
        onSignedIn={async () => {
          const me = await getAuthMe();
          setAuthUser(me);
          await refreshProjects();
          const pendingShare = shareTokenFromPath || window.sessionStorage.getItem("share.token.pending");
          if (pendingShare) {
            window.sessionStorage.removeItem("share.token.pending");
            try {
              const joined = await joinProjectShareLink(pendingShare);
              await refreshProjects();
              navigate(`/project/${joined.project_id}`, { replace: true });
            } catch (err) {
              setError(err instanceof Error ? err.message : t("share.joinFailed"));
            }
          }
        }}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className={`topbar ${onWorkspaceRoute ? "workspace" : ""}`}>
        <strong className="topbar-brand">{siteName}</strong>
        {onWorkspaceRoute && (
          <UiButton className="tab" onClick={() => navigate("/projects")}>
            {t("nav.backToProjects")}
          </UiButton>
        )}
        <div className="topbar-workspace-slot">{onWorkspaceRoute ? workspaceTopbar : null}</div>
        <div className="meta">
          {!onWorkspaceRoute && (
            <>
              <Link className={`ui-button ui-secondary ui-md tab ${onProjectsRoute ? "active" : ""}`} to="/projects">
                {t("nav.projects")}
              </Link>
              <Link className={`ui-button ui-secondary ui-md tab ${onProfileRoute ? "active" : ""}`} to="/profile">
                {t("nav.profile")}
              </Link>
              {hasOrgAdminAccess && (
                <Link className={`ui-button ui-secondary ui-md tab ${onAdminRoute ? "active" : ""}`} to="/admin">
                  {t("nav.admin")}
                </Link>
              )}
            </>
          )}
          <span>{authUser.display_name}</span>
          <UiButton onClick={handleLogout}>
            {t("nav.logout")}
          </UiButton>
        </div>
      </header>
      {error && <div className="error-banner">{error}</div>}
      <section className="app-content">
        <WorkspaceTopbarContext.Provider value={setWorkspaceTopbar}>
          <Routes>
            <Route path="/" element={<Navigate to={firstProject ? `/project/${firstProject}` : "/projects"} replace />} />
            <Route
              path="/projects"
              element={
                <ProjectsPage
                  projects={projects}
                  organizations={organizations}
                  refreshProjects={refreshProjects}
                  t={t}
                />
              }
            />
            <Route
              path="/project/:projectId"
              element={
                <WorkspacePage
                  projects={projects}
                  organizations={organizations}
                  authUser={authUser}
                  refreshProjects={refreshProjects}
                  t={t}
                />
              }
            />
            <Route
              path="/share/:token"
              element={<ShareJoinPage t={t} onJoin={async (token) => joinProjectShareLink(token)} />}
            />
            <Route path="/admin" element={<AdminPage t={t} />} />
            <Route path="/profile" element={<ProfilePage t={t} />} />
          </Routes>
        </WorkspaceTopbarContext.Provider>
      </section>
    </main>
  );
}

function WorkspacePage({
  projects,
  organizations,
  authUser,
  refreshProjects,
  t
}: {
  projects: Project[];
  organizations: OrganizationMembership[];
  authUser: AuthUser;
  refreshProjects: () => Promise<void>;
  t: (key: string) => string;
}) {
  const setWorkspaceTopbar = useContext(WorkspaceTopbarContext);
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const effectiveUserId = authUser.user_id;
  const effectiveUserName = authUser.display_name || "User";
  const ydocRef = useRef<Y.Doc | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const realtimeRef = useRef<{ close: () => void; sendCursor: (cursor: { line: number; column: number }) => void } | null>(null);
  const canvasPreviewRef = useRef<HTMLDivElement | null>(null);
  const centerSplitRef = useRef<HTMLDivElement | null>(null);
  const previewPanCleanupRef = useRef<(() => void) | null>(null);
  const lastSavedDocRef = useRef<string>("");
  const copyNoticeTimerRef = useRef<number | null>(null);
  const thumbnailUploadTimerRef = useRef<number | null>(null);
  const lastUploadedThumbnailRef = useRef<string>("");

  const [nodes, setNodes] = useState<{ path: string; kind: "file" | "directory" }[]>([]);
  const [entryFilePath, setEntryFilePath] = useState("main.typ");
  const [activePath, setActivePath] = useState("main.typ");
  const [docs, setDocs] = useState<Record<string, string>>({});
  const [assetBase64, setAssetBase64] = useState<Record<string, string>>({});
  const [assetMeta, setAssetMeta] = useState<Record<string, AssetMeta>>({});
  const [docText, setDocText] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [presence, setPresence] = useState<PresencePeer[]>([]);
  const [vectorData, setVectorData] = useState<Uint8Array | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [compileDiagnostics, setCompileDiagnostics] = useState<CompileDiagnostic[]>([]);
  const [compiledAt, setCompiledAt] = useState<number | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [activeRevisionId, setActiveRevisionId] = useState<string | null>(null);
  const [revisionDocs, setRevisionDocs] = useState<Record<string, string>>({});
  const [revisionNodes, setRevisionNodes] = useState<{ path: string; kind: "file" | "directory" }[]>([]);
  const [revisionEntryFilePath, setRevisionEntryFilePath] = useState("main.typ");
  const [revisionAssetBase64, setRevisionAssetBase64] = useState<Record<string, string>>({});
  const [revisionAssetMeta, setRevisionAssetMeta] = useState<Record<string, AssetMeta>>({});
  const [showFilesPanel, setShowFilesPanel] = useState(true);
  const [showRevisionPanel, setShowRevisionPanel] = useState(false);
  const [showProjectSettingsPanel, setShowProjectSettingsPanel] = useState(false);
  const [showPreviewPanel, setShowPreviewPanel] = useState(true);
  const [filesPanelWidth, setFilesPanelWidth] = useState(DEFAULT_LAYOUT_PREFS.filesWidth);
  const [settingsPanelWidth, setSettingsPanelWidth] = useState(DEFAULT_LAYOUT_PREFS.settingsWidth);
  const [revisionsPanelWidth, setRevisionsPanelWidth] = useState(DEFAULT_LAYOUT_PREFS.revisionsWidth);
  const [editorRatio, setEditorRatio] = useState(DEFAULT_LAYOUT_PREFS.editorRatio);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewFitMode, setPreviewFitMode] = useState<PreviewFitMode>("page");
  const [previewRenderTick, setPreviewRenderTick] = useState(0);
  const [previewIsPanning, setPreviewIsPanning] = useState(false);
  const [lineWrapEnabled, setLineWrapEnabled] = useState(true);
  const [jumpTarget, setJumpTarget] = useState<{ line: number; column: number; token: number } | null>(null);
  const [queuedJump, setQueuedJump] = useState<{ path: string; line: number; column: number } | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set([""]));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [filesDropActive, setFilesDropActive] = useState(false);
  const [shareLinks, setShareLinks] = useState<ProjectShareLink[]>([]);
  const [projectOrgAccess, setProjectOrgAccess] = useState<ProjectOrganizationAccess[]>([]);
  const [projectTemplateOrgAccess, setProjectTemplateOrgAccess] = useState<ProjectTemplateOrganizationAccess[]>([]);
  const [projectAccessUsers, setProjectAccessUsers] = useState<ProjectAccessUser[]>([]);
  const [templateEnabled, setTemplateEnabled] = useState(false);
  const [pathDialog, setPathDialog] = useState<PathDialogState | null>(null);
  const [copyDialog, setCopyDialog] = useState<ProjectCopyDialogState | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const [typstRuntimeStatus, setTypstRuntimeStatus] = useState<TypstRuntimeStatus>({ stage: "idle" });
  const [apiReachable, setApiReachable] = useState(true);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting");
  const [copiedControl, setCopiedControl] = useState<string | null>(null);

  const isRevisionMode = !!activeRevisionId;
  const currentNodes = isRevisionMode ? revisionNodes : nodes;
  const sourceAssetBase64 = isRevisionMode ? revisionAssetBase64 : assetBase64;
  const sourceAssetMeta = isRevisionMode ? revisionAssetMeta : assetMeta;
  const sourceEntryFilePath = isRevisionMode ? revisionEntryFilePath : entryFilePath;
  const tree = useMemo(() => projectTreeFromFlat(currentNodes), [currentNodes]);
  const hasActiveLiveDoc = Object.prototype.hasOwnProperty.call(docs, activePath);
  const isActiveTextDoc = isRevisionMode
    ? Object.prototype.hasOwnProperty.call(revisionDocs, activePath)
    : hasActiveLiveDoc;
  const activePathExistsInTree = currentNodes.some((node) => node.kind === "file" && node.path === activePath);
  const currentEditorLanguage = editorLanguageForPath(activePath);
  const sourceDocs = isRevisionMode ? revisionDocs : docs;
  const compileDocuments = useMemo(() => {
    const baseDocs = { ...sourceDocs };
    if (!isRevisionMode && activePath && activePath in baseDocs) {
      baseDocs[activePath] = docText;
    }
    return Object.entries(baseDocs).map(([path, content]) => ({ path, content }));
  }, [activePath, docText, isRevisionMode, sourceDocs]);
  const compileAssets = useMemo(
    () => Object.entries(sourceAssetBase64).map(([path, contentBase64]) => ({ path, contentBase64 })),
    [sourceAssetBase64]
  );
  const assetFontData = useMemo(
    () =>
      Object.entries(sourceAssetBase64)
        .filter(([path]) => isFontFile(path))
        .map(([, b64]) => {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          return bytes;
        }),
    [sourceAssetBase64]
  );
  const fontData = useMemo(() => assetFontData, [assetFontData]);
  const remoteCursors = useMemo(
    () =>
      presence
        .filter((peer) => peer.id !== effectiveUserId)
        .map((peer) => ({
          id: peer.id,
          name:
            peer.name && !looksLikeUuid(peer.name)
              ? peer.name
              : looksLikeUuid(peer.id)
                ? "Collaborator"
                : peer.id,
          color: presenceColor(peer.id),
          line: peer.line,
          column: peer.column
        })),
    [effectiveUserId, presence]
  );
  const activeAsset = sourceAssetMeta[activePath];
  const activeAssetBase64 = sourceAssetBase64[activePath];
  const activeAssetType = inferContentType(activePath, activeAsset?.contentType);
  const assetDataUrl = activeAssetBase64 ? `data:${activeAssetType};base64,${activeAssetBase64}` : "";
  const project = projects.find((p) => p.id === projectId);
  const canWrite = project?.my_role !== "Viewer";
  const canManageProject = project?.my_role === "Owner" || project?.my_role === "Teacher";
  const activeReadShare = shareLinks.find((link) => link.permission === "read" && !link.revoked_at) ?? null;
  const activeWriteShare = shareLinks.find((link) => link.permission === "write" && !link.revoked_at) ?? null;
  const myOrganizations = organizations;
  const typEntryOptions = useMemo(() => {
    const values = new Set<string>();
    for (const path of Object.keys(docs)) {
      if (path.endsWith(".typ")) values.add(path);
    }
    for (const node of nodes) {
      if (node.kind === "file" && node.path.endsWith(".typ")) values.add(node.path);
    }
    if (entryFilePath.endsWith(".typ")) values.add(entryFilePath);
    if (values.size === 0) values.add("main.typ");
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [docs, entryFilePath, nodes]);
  const formatAccessType = (accessType: string, role: string) => {
    if (accessType === "manage") return "Manage";
    if (accessType === "write") return "Read + write";
    if (accessType === "read") return "Read only";
    return role;
  };
  const formatRoleLabel = (role: string) => {
    if (role === "Teacher") return "Manager";
    if (role === "TA") return "Maintainer";
    if (role === "Student") return "Contributor";
    return role;
  };
  const formatAccessSource = (source: string) => {
    if (source === "share_link_invite") return "Accepted share link";
    if (source === "direct_role") return "Direct assignment";
    if (source.startsWith("organization:")) {
      return `Organization (${source.slice("organization:".length)})`;
    }
    return source;
  };
  const previewPixelPerPt = pixelPerPtForZoom(previewFitMode, previewZoom);
  const previewPercent = Math.round(previewZoom * 100);
  const activeFileName = activePath.split("/").filter(Boolean).at(-1) || activePath;
  const realtimeRequired = isActiveTextDoc && !isRevisionMode;
  const serverReachable = apiReachable && (!realtimeRequired || realtimeStatus !== "disconnected");

  useEffect(() => {
    if (!project?.is_template) return;
    setCopyDialog((current) => {
      if (current && current.projectId === project.id) return current;
      return {
        projectId: project.id,
        sourceName: project.name,
        suggestedName: `${project.name} ${t("projects.copySuffix")}`
      };
    });
  }, [project?.id, project?.is_template, project?.name, t]);

  useEffect(() => {
    setTemplateEnabled(!!project?.is_template);
  }, [project?.id, project?.is_template]);

  const refreshProjectData = async () => {
    if (!projectId) return;
    if (project?.is_template && !project.can_read) {
      setWorkspaceLoaded(true);
      return;
    }
    setWorkspaceLoaded(false);
    const cached = loadProjectSnapshotFromCache(projectId);
    if (cached) {
      setNodes(cached.nodes);
      setEntryFilePath(cached.entryFilePath || "main.typ");
      setDocs(cached.docs || {});
      const cachedPaths = new Set(cached.nodes.map((node) => node.path));
      const fallbackPath =
        activePath && cachedPaths.has(activePath)
          ? activePath
          : cached.nodes.find((node) => node.kind === "file")?.path || cached.entryFilePath || "main.typ";
      setActivePath(fallbackPath);
      setExpandedDirs((prev) => expandAncestors(fallbackPath, prev));
      setWorkspaceLoaded(true);
    }
    const sharePromise = canManageProject ? listProjectShareLinks(projectId).catch(() => []) : Promise.resolve([]);
    const orgAccessPromise = canManageProject
      ? listProjectOrganizationAccess(projectId).catch(() => [])
      : Promise.resolve([]);
    const templateOrgAccessPromise = canManageProject
      ? listProjectTemplateOrganizationAccess(projectId).catch(() => [])
      : Promise.resolve([]);
    const accessUsersPromise = canManageProject
      ? listProjectAccessUsers(projectId).then((res) => res.users).catch(() => [])
      : Promise.resolve([]);
    const responseTuple = await Promise.all([
        getProjectTree(projectId),
        getProjectSettings(projectId).catch(() => ({ entry_file_path: "main.typ" })),
        getGitRepoLink(projectId).catch(() => ({ repo_url: "" })),
        listDocuments(projectId),
        listRevisions(projectId).catch(() => ({ revisions: [] })),
        listProjectAssets(projectId).catch(() => ({ assets: [] })),
        sharePromise,
        orgAccessPromise,
        templateOrgAccessPromise,
        accessUsersPromise
      ]).catch((err) => {
        if (cached) {
          setWorkspaceError("Working from cached project data (offline mode).");
          setApiReachable(false);
          return null;
        }
        throw err;
      });
    if (!responseTuple) return;
    let [treeRes, settings, git, docsRes, revisionsRes, assetsRes, shareRes, orgAccessRes, templateOrgAccessRes, accessUsersRes] = responseTuple;
    if (!treeRes.nodes.some((node) => node.kind === "file")) {
      await createProjectFile(projectId, {
        path: "main.typ",
        kind: "file",
        content: ""
      }).catch(() => undefined);
      const [nextTree, nextDocs] = await Promise.all([getProjectTree(projectId), listDocuments(projectId)]);
      treeRes = nextTree;
      docsRes = nextDocs;
    }
    setNodes(treeRes.nodes);
    setEntryFilePath(settings.entry_file_path || treeRes.entry_file_path || "main.typ");
    setGitRepoUrl(git.repo_url || "");
    setRevisions(revisionsRes.revisions || []);
    setShareLinks(shareRes);
    setProjectOrgAccess(orgAccessRes);
    setProjectTemplateOrgAccess(templateOrgAccessRes);
    setProjectAccessUsers(accessUsersRes);

    const nextDocs: Record<string, string> = {};
    for (const doc of docsRes.documents) nextDocs[doc.path] = doc.content;
    setDocs(nextDocs);
    saveProjectSnapshotToCache({
      projectId,
      entryFilePath: settings.entry_file_path || treeRes.entry_file_path || "main.typ",
      nodes: treeRes.nodes,
      docs: nextDocs
    });

    const nextAssets: Record<string, string> = {};
    const nextAssetMeta: Record<string, AssetMeta> = {};
    for (const asset of assetsRes.assets) {
      nextAssetMeta[asset.path] = {
        id: asset.id,
        contentType: asset.content_type
      };
    }
    await Promise.all(
      assetsRes.assets.map(async (asset) => {
        try {
          const content = await getProjectAssetContent(projectId, asset.id);
          nextAssets[asset.path] = content.content_base64;
        } catch {
          // Skip unreadable assets.
        }
      })
    );
    setAssetMeta(nextAssetMeta);
    setAssetBase64(nextAssets);

    if (!activePath || !treeRes.nodes.some((node) => node.path === activePath)) {
      const firstFile = treeRes.nodes.find((n) => n.kind === "file")?.path || settings.entry_file_path;
      const target = firstFile || "main.typ";
      setActivePath(target);
      setExpandedDirs((prev) => expandAncestors(target, prev));
    }
    setApiReachable(true);
    setWorkspaceError(null);
    setWorkspaceLoaded(true);
  };

  useEffect(() => {
    const unsub = subscribeTypstRuntimeStatus((status) => setTypstRuntimeStatus(status));
    return () => unsub();
  }, []);

  useEffect(() => {
    return () => {
      if (copyNoticeTimerRef.current) {
        window.clearTimeout(copyNoticeTimerRef.current);
      }
      if (thumbnailUploadTimerRef.current) {
        window.clearTimeout(thumbnailUploadTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const stored = readWorkspaceLayoutPrefs();
    setFilesPanelWidth(stored.filesWidth);
    setSettingsPanelWidth(stored.settingsWidth);
    setRevisionsPanelWidth(stored.revisionsWidth);
    setEditorRatio(stored.editorRatio);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload: WorkspaceLayoutPrefs = {
      filesWidth: clampNumber(filesPanelWidth, MIN_SIDE_PANEL_WIDTH, MAX_SIDE_PANEL_WIDTH),
      settingsWidth: clampNumber(settingsPanelWidth, MIN_SIDE_PANEL_WIDTH, MAX_SIDE_PANEL_WIDTH),
      revisionsWidth: clampNumber(revisionsPanelWidth, MIN_SIDE_PANEL_WIDTH, MAX_SIDE_PANEL_WIDTH),
      editorRatio: clampNumber(editorRatio, MIN_EDITOR_RATIO, MAX_EDITOR_RATIO)
    };
    window.localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(payload));
  }, [editorRatio, filesPanelWidth, revisionsPanelWidth, settingsPanelWidth]);

  useEffect(() => {
    setWorkspaceLoaded(false);
    setWorkspaceError(null);
    setActiveRevisionId(null);
    setRevisionDocs({});
    setRevisionNodes([]);
    setRevisionAssetBase64({});
    setRevisionAssetMeta({});
    setRevisionEntryFilePath("main.typ");
    setCompileErrors([]);
    setCompileDiagnostics([]);
    setVectorData(null);
    setPdfData(null);
    setCompiledAt(null);
    setPresence([]);
    setDocText("");
    setContextMenu(null);
    setProjectTemplateOrgAccess([]);
    refreshProjectData().catch((err) => {
      const message = err instanceof Error ? err.message : "Unable to load workspace";
      setWorkspaceError(message);
      setApiReachable(false);
      setWorkspaceLoaded(true);
    });
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded || isRevisionMode) return;
    const nextDocs = { ...docs };
    if (activePath && Object.prototype.hasOwnProperty.call(nextDocs, activePath)) {
      nextDocs[activePath] = docText;
    }
    saveProjectSnapshotToCache({
      projectId,
      entryFilePath,
      nodes,
      docs: nextDocs
    });
  }, [activePath, docText, docs, entryFilePath, isRevisionMode, nodes, projectId, workspaceLoaded]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded || !canManageProject) return;
    Promise.all([
      listProjectShareLinks(projectId).catch(() => []),
      listProjectOrganizationAccess(projectId).catch(() => []),
      listProjectTemplateOrganizationAccess(projectId).catch(() => []),
      listProjectAccessUsers(projectId).then((res) => res.users).catch(() => [])
    ])
      .then(([shares, orgAccess, templateOrgAccess, users]) => {
        setShareLinks(shares);
        setProjectOrgAccess(orgAccess);
        setProjectTemplateOrgAccess(templateOrgAccess);
        setProjectAccessUsers(users);
      })
      .catch(() => undefined);
  }, [canManageProject, projectId, workspaceLoaded]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const response = await fetch("/health", { cache: "no-store", credentials: "include" });
        if (cancelled) return;
        setApiReachable(response.ok);
      } catch {
        if (cancelled) return;
        setApiReachable(false);
      }
    };
    run().catch(() => undefined);
    const timer = window.setInterval(() => {
      run().catch(() => undefined);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (showRevisionPanel) return;
    if (!activeRevisionId) return;
    setActiveRevisionId(null);
    setRevisionDocs({});
    setRevisionNodes([]);
    setRevisionAssetBase64({});
    setRevisionAssetMeta({});
    setRevisionEntryFilePath("main.typ");
  }, [activeRevisionId, showRevisionPanel]);

  useEffect(() => {
    setExpandedDirs((prev) => expandAncestors(activePath, prev));
  }, [activePath]);

  useEffect(() => {
    if (!queuedJump) return;
    if (queuedJump.path !== activePath) return;
    setJumpTarget({
      line: queuedJump.line,
      column: queuedJump.column,
      token: Date.now()
    });
    setQueuedJump(null);
  }, [activePath, queuedJump]);

  useEffect(() => {
    return () => {
      if (previewPanCleanupRef.current) {
        previewPanCleanupRef.current();
        previewPanCleanupRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isRevisionMode) return;
    setDocText(revisionDocs[activePath] ?? "");
  }, [activePath, isRevisionMode, revisionDocs]);

  useEffect(() => {
    if (isRevisionMode) return;
    if (!projectId || !activePath) {
      setDocText("");
      return;
    }
    setDocText(docs[activePath] ?? "");
  }, [activePath, isRevisionMode, projectId]);

  useEffect(() => {
    if (!projectId || !activePath || isRevisionMode || !workspaceLoaded) return;
    if (!hasActiveLiveDoc) {
      setPresence([]);
      setDocText("");
      setRealtimeStatus("disconnected");
      return;
    }
    const fileContent = docs[activePath] ?? "";
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("main");
    ydocRef.current = ydoc;
    ytextRef.current = ytext;
    const baselineDoc = new Y.Doc();
    baselineDoc.clientID = 1;
    baselineDoc.getText("main").insert(0, fileContent);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(baselineDoc), "bootstrap");
    baselineDoc.destroy();
    lastSavedDocRef.current = fileContent;
    setDocText(fileContent);

    const observer = (event: Y.YTextEvent) => {
      const next = event.target.toString();
      setDocText(next);
    };
    ytext.observe(observer);
    const realtime = bindRealtimeYDoc({
      docId: `${projectId}:${activePath}`,
      projectId,
      wsBaseUrl: `${window.location.origin.replace(/^http/, "ws")}`,
      ydoc,
      userId: effectiveUserId,
      userName: effectiveUserName,
      onPresenceChange: setPresence,
      onStatusChange: setRealtimeStatus
    });
    realtimeRef.current = realtime;
    return () => {
      ytext.unobserve(observer);
      realtime.close();
      ydoc.destroy();
      ydocRef.current = null;
      ytextRef.current = null;
      realtimeRef.current = null;
      setPresence([]);
      setRealtimeStatus("disconnected");
    };
  }, [
    activePath,
    effectiveUserId,
    effectiveUserName,
    hasActiveLiveDoc,
    isRevisionMode,
    projectId,
    workspaceLoaded
  ]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded || isRevisionMode) return;
    const timer = window.setInterval(() => {
      listDocuments(projectId)
        .then((response) => {
          setApiReachable(true);
          const incomingByPath: Record<string, string> = {};
          for (const doc of response.documents) incomingByPath[doc.path] = doc.content;
          const activeIncoming = activePath ? incomingByPath[activePath] : undefined;
          const localDirty = docText !== lastSavedDocRef.current;

          if (
            activePath &&
            typeof activeIncoming === "string" &&
            activeIncoming !== lastSavedDocRef.current &&
            !localDirty
          ) {
            const ytext = ytextRef.current;
            if (ytext) {
              const current = ytext.toString();
              if (current !== activeIncoming) {
                ytext.doc?.transact(() => {
                  ytext.delete(0, ytext.length);
                  ytext.insert(0, activeIncoming);
                }, "remote");
              }
            } else if (docText !== activeIncoming) {
              setDocText(activeIncoming);
            }
            lastSavedDocRef.current = activeIncoming;
            setSaveState("saved");
          }

          setDocs((previous) => {
            let changed = false;
            const next = { ...previous };
            for (const [path, content] of Object.entries(incomingByPath)) {
              if (next[path] !== content) {
                if (path === activePath && localDirty) continue;
                next[path] = content;
                changed = true;
              }
            }
            for (const path of Object.keys(next)) {
              if (path === activePath && localDirty) continue;
              if (!(path in incomingByPath)) {
                delete next[path];
                changed = true;
              }
            }
            return changed ? next : previous;
          });
        })
        .catch(() => setApiReachable(false));
    }, 2200);
    return () => window.clearInterval(timer);
  }, [activePath, docText, isRevisionMode, projectId, workspaceLoaded]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded) return;
    const timer = window.setInterval(() => {
      listRevisions(projectId)
        .then((res) => {
          setApiReachable(true);
          setRevisions(res.revisions || []);
        })
        .catch(() => setApiReachable(false));
    }, 8000);
    return () => window.clearInterval(timer);
  }, [projectId, workspaceLoaded]);

  useEffect(() => {
    if (!projectId || !activePath || isRevisionMode || !workspaceLoaded) return;
    if (!hasActiveLiveDoc) return;
    if (docText === lastSavedDocRef.current) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      upsertDocumentByPath(projectId, activePath, docText)
        .then((saved) => {
          setApiReachable(true);
          lastSavedDocRef.current = saved.content;
          setDocs((prev) => ({ ...prev, [saved.path]: saved.content }));
          setSaveState("saved");
        })
        .catch(() => {
          setApiReachable(false);
          setSaveState("error");
        });
    }, 320);
    return () => window.clearTimeout(timer);
  }, [activePath, docText, hasActiveLiveDoc, isRevisionMode, projectId, workspaceLoaded]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded) return;
    let cancelled = false;
    if (compileDocuments.length === 0) {
      setVectorData(null);
      setPdfData(null);
      setCompileErrors(["Project has no source documents"]);
      setCompileDiagnostics([]);
      setCompiledAt(Date.now());
      return;
    }
    startTransition(() => {
      compileTypstClientSide({
        entryFilePath: sourceEntryFilePath,
        documents: compileDocuments,
        assets: compileAssets,
        coreApiUrl: "",
        fontData,
        appOrigin: window.location.origin
      }).then((output) => {
        if (cancelled) return;
        setVectorData(output.vectorData);
        setPdfData(output.pdfData);
        setCompileErrors(output.errors);
        setCompileDiagnostics(output.diagnostics);
        setCompiledAt(output.compiledAt);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [compileAssets, compileDocuments, fontData, projectId, sourceEntryFilePath, workspaceLoaded]);

  useEffect(() => {
    if (!showPreviewPanel) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    if (!vectorData) {
      setPreviewRenderTick((value) => value + 1);
      return;
    }
    let cancelled = false;
    renderTypstVectorToCanvas(frame, vectorData, { pixelPerPt: previewPixelPerPt })
      .then(() => {
        if (cancelled) return;
        const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
        if (pages) {
          const zoom = previewFitMode === "manual" ? previewZoom : deriveFitZoom(frame, pages, previewFitMode);
          applyPreviewZoom(frame, zoom);
          if (previewFitMode !== "manual" && Math.abs(zoom - previewZoom) > 0.01) {
            setPreviewZoom(zoom);
          }
        }
        setPreviewRenderTick((value) => value + 1);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : "Preview render failed";
        setCompileErrors([message]);
        setCompileDiagnostics([]);
      });
    return () => {
      cancelled = true;
    };
  }, [previewPixelPerPt, showPreviewPanel, vectorData]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded || isRevisionMode || !showPreviewPanel) return;
    if (!vectorData || compileDiagnostics.length > 0 || compileErrors.length > 0) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const firstCanvas = frame.querySelector(".pdf-pages canvas") as HTMLCanvasElement | null;
    if (!firstCanvas) return;
    if (thumbnailUploadTimerRef.current) {
      window.clearTimeout(thumbnailUploadTimerRef.current);
    }
    thumbnailUploadTimerRef.current = window.setTimeout(() => {
      const latestCanvas = (canvasPreviewRef.current?.querySelector(".pdf-pages canvas") ||
        firstCanvas) as HTMLCanvasElement | null;
      if (!latestCanvas) return;
      const dataUrl = latestCanvas.toDataURL("image/png");
      const base64 = dataUrl.split(",")[1] || "";
      if (!base64) return;
      const digest = `${base64.length}:${base64.slice(0, 128)}`;
      if (digest === lastUploadedThumbnailRef.current) return;
      uploadProjectThumbnail(projectId, {
        content_base64: base64,
        content_type: "image/png"
      })
        .then(() => {
          lastUploadedThumbnailRef.current = digest;
        })
        .catch(() => undefined);
    }, 1200);
    return () => {
      if (thumbnailUploadTimerRef.current) {
        window.clearTimeout(thumbnailUploadTimerRef.current);
        thumbnailUploadTimerRef.current = null;
      }
    };
  }, [
    compileDiagnostics.length,
    compileErrors.length,
    isRevisionMode,
    previewRenderTick,
    projectId,
    showPreviewPanel,
    vectorData,
    workspaceLoaded
  ]);

  useEffect(() => {
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
    if (!pages) return;
    const zoom = previewFitMode === "manual" ? previewZoom : deriveFitZoom(frame, pages, previewFitMode);
    applyPreviewZoom(frame, zoom);
    if (previewFitMode !== "manual" && Math.abs(zoom - previewZoom) > 0.01) {
      setPreviewZoom(zoom);
    }
  }, [
    editorRatio,
    previewFitMode,
    previewRenderTick,
    previewZoom,
    showFilesPanel,
    showPreviewPanel,
    showProjectSettingsPanel,
    showRevisionPanel
  ]);

  useEffect(() => {
    if (!showPreviewPanel) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => {
      const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
      if (!pages || previewFitMode === "manual") return;
      const zoom = deriveFitZoom(frame, pages, previewFitMode);
      applyPreviewZoom(frame, zoom);
      setPreviewZoom(zoom);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [previewFitMode, showPreviewPanel]);

  useEffect(() => {
    if (!showPreviewPanel) return;
    if (previewFitMode === "manual") return;
    const onResize = () => {
      const frame = canvasPreviewRef.current;
      if (!frame) return;
      const pages = frame.querySelector(".pdf-pages") as HTMLElement | null;
      if (!pages) return;
      const zoom = deriveFitZoom(frame, pages, previewFitMode);
      applyPreviewZoom(frame, zoom);
      setPreviewZoom(zoom);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [previewFitMode, showPreviewPanel]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".context-menu")) return;
      setContextMenu(null);
    };
    const closeOnScroll = () => setContextMenu(null);
    window.addEventListener("click", closeMenu, true);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      window.removeEventListener("click", closeMenu, true);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [contextMenu]);

  function applyDocumentDeltas(changes: EditorChange[]) {
    if (isRevisionMode || !canWrite || changes.length === 0) return;
    const ydoc = ydocRef.current;
    const ytext = ytextRef.current;
    if (!ydoc || !ytext) return;
    ydoc.transact(() => {
      // Apply from right-to-left so CodeMirror positions stay stable in Yjs.
      const ordered = [...changes].sort((a, b) => b.from - a.from || b.to - a.to);
      for (const change of ordered) {
        const from = Math.max(0, change.from);
        const to = Math.max(from, change.to);
        const deleteCount = Math.max(0, to - from);
        if (deleteCount > 0) ytext.delete(from, deleteCount);
        if (change.insert) ytext.insert(from, change.insert);
      }
    });
  }

  function addPath(kind: "file" | "directory", parentPath = "") {
    if (!projectId || !canWrite || isRevisionMode) return;
    const placeholder = kind === "file" ? "untitled.typ" : "folder";
    setPathDialog({
      mode: "create",
      kind,
      parentPath,
      value: joinProjectPath(parentPath, placeholder)
    });
  }

  function renamePath(path: string) {
    if (!projectId || !canWrite || isRevisionMode) return;
    setPathDialog({
      mode: "rename",
      path,
      value: path
    });
  }

  function removePath(path: string) {
    if (!projectId || !canWrite || isRevisionMode) return;
    setPathDialog({
      mode: "delete",
      path
    });
  }

  async function submitPathDialog() {
    if (!projectId || !pathDialog || !canWrite || isRevisionMode) return;
    try {
      setContextMenu(null);
      if (pathDialog.mode === "create") {
        let normalized = normalizePath(pathDialog.value);
        if (pathDialog.parentPath && !normalized.includes("/")) {
          normalized = joinProjectPath(pathDialog.parentPath, normalized);
        }
        if (!normalized) return;
        await createProjectFile(projectId, {
          path: normalized,
          kind: pathDialog.kind,
          content: pathDialog.kind === "file" ? "" : undefined
        });
        await refreshProjectData();
        if (pathDialog.kind === "file") setActivePath(normalized);
      } else if (pathDialog.mode === "rename") {
        let normalizedTo = normalizePath(pathDialog.value);
        const parentPath = parentProjectPath(pathDialog.path);
        if (parentPath && !normalizedTo.includes("/")) {
          normalizedTo = joinProjectPath(parentPath, normalizedTo);
        }
        if (!normalizedTo || normalizedTo === pathDialog.path) {
          setPathDialog(null);
          return;
        }
        await moveProjectFile(projectId, pathDialog.path, normalizedTo);
        await refreshProjectData();
        if (activePath === pathDialog.path) setActivePath(normalizedTo);
      } else {
        await deleteProjectFile(projectId, pathDialog.path);
        if (activePath === pathDialog.path) setActivePath(entryFilePath);
        await refreshProjectData();
      }
      setPathDialog(null);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update path";
      setWorkspaceError(message);
    }
  }

  type UploadCandidate = {
    relativePath: string;
    file: File;
  };

  async function commitUploads(items: UploadCandidate[], parentPath = "") {
    if (!projectId || items.length === 0 || !canWrite || isRevisionMode) return;
    try {
      setContextMenu(null);
      for (const item of items) {
        const path = normalizePath(joinProjectPath(parentPath, item.relativePath || item.file.name));
        const bytes = new Uint8Array(await item.file.arrayBuffer());
        if (isTextFile(path) || item.file.type.startsWith("text/")) {
          const text = new TextDecoder().decode(bytes);
          await upsertDocumentByPath(projectId, path, text);
          setDocs((prev) => ({ ...prev, [path]: text }));
        } else {
          const binary = Array.from(bytes, (value) => String.fromCharCode(value)).join("");
          await uploadProjectAsset(projectId, {
            path,
            content_base64: btoa(binary),
            content_type: item.file.type || "application/octet-stream"
          });
        }
      }
      await refreshProjectData();
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to upload";
      setWorkspaceError(message);
    }
  }

  function uploadFromPicker(parentPath = "") {
    if (!canWrite || isRevisionMode) return;
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.onchange = async () => {
      const files = Array.from(picker.files || []).map((file) => ({
        relativePath: file.name,
        file
      }));
      await commitUploads(files, parentPath);
    };
    picker.click();
  }

  async function collectDragFiles(dataTransfer: DataTransfer): Promise<UploadCandidate[]> {
    const output: UploadCandidate[] = [];
    const pending: Array<Promise<void>> = [];
    const itemList = Array.from(dataTransfer.items || []);

    const walkEntry = async (entry: any, prefix: string) => {
      if (!entry) return;
      if (entry.isFile) {
        await new Promise<void>((resolve) => {
          entry.file(
            (file: File) => {
              const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
              output.push({ relativePath, file });
              resolve();
            },
            () => resolve()
          );
        });
        return;
      }
      if (!entry.isDirectory) return;
      const currentPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      const readAll = async (): Promise<any[]> => {
        const all: any[] = [];
        while (true) {
          const batch = await new Promise<any[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
          if (!batch.length) break;
          all.push(...batch);
        }
        return all;
      };
      const entries = await readAll();
      for (const child of entries) {
        await walkEntry(child, currentPrefix);
      }
    };

    for (const item of itemList) {
      const entry = (item as any).webkitGetAsEntry?.();
      if (entry) {
        pending.push(walkEntry(entry, ""));
      } else {
        const file = item.getAsFile();
        if (!file) continue;
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        output.push({ relativePath, file });
      }
    }
    if (pending.length > 0) {
      await Promise.all(pending);
      return output;
    }
    for (const file of Array.from(dataTransfer.files || [])) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      output.push({ relativePath, file });
    }
    return output;
  }

  async function onTreeDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setFilesDropActive(false);
    if (!canWrite || isRevisionMode) return;
    const items = await collectDragFiles(event.dataTransfer);
    await commitUploads(items, "");
  }

  async function downloadArchive() {
    if (!projectId) return;
    try {
      const blob = await downloadProjectArchive(projectId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project?.name || "project"}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to download archive";
      setWorkspaceError(message);
    }
  }

  async function createShare(permission: "read" | "write") {
    if (!projectId) return;
    try {
      await createProjectShareLink(projectId, { permission });
      const latest = await listProjectShareLinks(projectId);
      setShareLinks(latest);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to create share link";
      setWorkspaceError(message);
    }
  }

  async function revokeShare(shareLinkId: string) {
    if (!projectId) return;
    try {
      await revokeProjectShareLink(projectId, shareLinkId);
      const latest = await listProjectShareLinks(projectId);
      setShareLinks(latest);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to revoke share link";
      setWorkspaceError(message);
    }
  }

  async function copyToClipboard(controlKey: string, value: string) {
    if (!value.trim()) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedControl(controlKey);
      if (copyNoticeTimerRef.current) {
        window.clearTimeout(copyNoticeTimerRef.current);
      }
      copyNoticeTimerRef.current = window.setTimeout(() => {
        setCopiedControl((current) => (current === controlKey ? null : current));
      }, 1600);
      setWorkspaceError(null);
    } catch {
      setWorkspaceError("Unable to copy to clipboard");
    }
  }

  async function createProjectFromTemplate() {
    if (!copyDialog || !copyDialog.suggestedName.trim()) return;
    try {
      setCopyBusy(true);
      const created = await copyProject(copyDialog.projectId, {
        name: copyDialog.suggestedName.trim()
      });
      setCopyDialog(null);
      await refreshProjects().catch(() => undefined);
      navigate(`/project/${created.id}`, { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : t("projects.copyFailed");
      setWorkspaceError(message);
    } finally {
      setCopyBusy(false);
    }
  }

  async function upsertOrgAccessGrant(organizationId: string, permission: "read" | "write") {
    if (!projectId) return;
    try {
      await upsertProjectOrganizationAccess(projectId, organizationId, permission);
      const [grants, users] = await Promise.all([
        listProjectOrganizationAccess(projectId).catch(() => []),
        listProjectAccessUsers(projectId).then((res) => res.users).catch(() => [])
      ]);
      setProjectOrgAccess(grants);
      setProjectAccessUsers(users);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update organization access";
      setWorkspaceError(message);
    }
  }

  async function setTemplateState(next: boolean) {
    if (!projectId) return;
    try {
      await updateProjectTemplate(projectId, next);
      setTemplateEnabled(next);
      await refreshProjects().catch(() => undefined);
      if (next) {
        const grants = await listProjectTemplateOrganizationAccess(projectId).catch(() => []);
        setProjectTemplateOrgAccess(grants);
      } else {
        setProjectTemplateOrgAccess([]);
      }
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update template settings";
      setWorkspaceError(message);
    }
  }

  async function removeOrgAccessGrant(organizationId: string) {
    if (!projectId) return;
    try {
      await deleteProjectOrganizationAccess(projectId, organizationId);
      const [grants, users] = await Promise.all([
        listProjectOrganizationAccess(projectId).catch(() => []),
        listProjectAccessUsers(projectId).then((res) => res.users).catch(() => [])
      ]);
      setProjectOrgAccess(grants);
      setProjectAccessUsers(users);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to remove organization access";
      setWorkspaceError(message);
    }
  }

  async function upsertTemplateOrgAccessGrant(organizationId: string) {
    if (!projectId) return;
    try {
      await upsertProjectTemplateOrganizationAccess(projectId, organizationId);
      const [grants] = await Promise.all([
        listProjectTemplateOrganizationAccess(projectId).catch(() => [])
      ]);
      setProjectTemplateOrgAccess(grants);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update template access";
      setWorkspaceError(message);
    }
  }

  async function removeTemplateOrgAccessGrant(organizationId: string) {
    if (!projectId) return;
    try {
      await deleteProjectTemplateOrganizationAccess(projectId, organizationId);
      const [grants] = await Promise.all([
        listProjectTemplateOrganizationAccess(projectId).catch(() => [])
      ]);
      setProjectTemplateOrgAccess(grants);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update template access";
      setWorkspaceError(message);
    }
  }

  async function openRevision(revisionId: string) {
    if (!projectId) return;
    if (activeRevisionId === revisionId) {
      setActiveRevisionId(null);
      setRevisionDocs({});
      setRevisionNodes([]);
      setRevisionAssetBase64({});
      setRevisionAssetMeta({});
      setRevisionEntryFilePath("main.typ");
      return;
    }
    try {
      const response = await getRevisionDocuments(projectId, revisionId);
      const map: Record<string, string> = {};
      for (const doc of response.documents) map[doc.path] = doc.content;
      const revisionAssets: Record<string, string> = {};
      const revisionAssetMetaMap: Record<string, AssetMeta> = {};
      for (const asset of response.assets || []) {
        revisionAssets[asset.path] = asset.content_base64;
        revisionAssetMetaMap[asset.path] = {
          contentType: asset.content_type
        };
      }
      setRevisionDocs(map);
      setRevisionNodes(response.nodes || []);
      setRevisionAssetBase64(revisionAssets);
      setRevisionAssetMeta(revisionAssetMetaMap);
      setRevisionEntryFilePath(response.entry_file_path || "main.typ");
      setActiveRevisionId(revisionId);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to load revision snapshot";
      setWorkspaceError(message);
    }
  }

  function downloadCompiledPdf() {
    if (!pdfData) return;
    const safeBytes = new Uint8Array(Array.from(pdfData));
    const blob = new Blob([safeBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sourceEntryFilePath.replace(/\.typ$/i, "") + ".pdf";
    a.click();
    URL.revokeObjectURL(url);
  }

  function openTreePath(path: string) {
    setActivePath(path);
    setExpandedDirs((prev) => expandAncestors(path, prev));
  }

  function jumpToDiagnostic(diagnostic: CompileDiagnostic) {
    const path = normalizePath(diagnostic.path || activePath);
    const line = Math.max(1, diagnostic.line ?? 1);
    const column = Math.max(1, diagnostic.column ?? 1);
    if (!path) {
      setJumpTarget({
        line,
        column,
        token: Date.now()
      });
      return;
    }
    setExpandedDirs((prev) => expandAncestors(path, prev));
    if (path !== activePath) {
      setQueuedJump({ path, line, column });
      setActivePath(path);
      return;
    }
    setJumpTarget({
      line,
      column,
      token: Date.now()
    });
  }

  function requestContextMenu(next: ContextMenuState) {
    setContextMenu(next);
  }

  function beginHorizontalResize(onDelta: (deltaX: number) => void) {
    return (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const onMove = (moveEvent: MouseEvent) => {
        onDelta(moveEvent.clientX - startX);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }

  function increasePreviewZoom() {
    setPreviewFitMode("manual");
    setPreviewZoom((value) => clampNumber(value + 0.1, PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM));
  }

  function decreasePreviewZoom() {
    setPreviewFitMode("manual");
    setPreviewZoom((value) => clampNumber(value - 0.1, PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM));
  }

  function toggleRevisionPanel() {
    setShowRevisionPanel((shown) => {
      if (shown) {
        setActiveRevisionId(null);
        setRevisionDocs({});
        setRevisionNodes([]);
        setRevisionAssetBase64({});
        setRevisionAssetMeta({});
        setRevisionEntryFilePath("main.typ");
      }
      return !shown;
    });
  }

  function setPreviewFitWholePage() {
    setPreviewFitMode("page");
  }

  function setPreviewFitPageWidth() {
    setPreviewFitMode("width");
  }

  function beginPreviewPan(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    const pages = frame.querySelector(".pdf-pages");
    if (!pages) return;
    const canPanX = frame.scrollWidth > frame.clientWidth + 1;
    const canPanY = frame.scrollHeight > frame.clientHeight + 1;
    if (!canPanX && !canPanY) return;

    const startX = event.clientX;
    const startY = event.clientY;
    const initialScrollLeft = frame.scrollLeft;
    const initialScrollTop = frame.scrollTop;
    setPreviewIsPanning(true);
    event.preventDefault();

    const onMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (canPanX) frame.scrollLeft = initialScrollLeft - deltaX;
      if (canPanY) frame.scrollTop = initialScrollTop - deltaY;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      previewPanCleanupRef.current = null;
      setPreviewIsPanning(false);
    };
    previewPanCleanupRef.current = onUp;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const workspaceTopbarControls = useMemo(
    () => (
      <div className="workspace-topbar-controls">
        <label className="workspace-project-picker workspace-topbar-project" aria-label={t("nav.projects")}>
          <UiSelect value={projectId} onChange={(e) => navigate(`/project/${e.target.value}`)}>
            {projects.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </UiSelect>
        </label>
        <div className="workspace-icon-toggles">
          <UiButton
            className={`icon-toggle ${showFilesPanel ? "active" : ""}`}
            aria-label={t("workspace.files")}
            title={t("workspace.files")}
            onClick={() => setShowFilesPanel((v) => !v)}
          >
            <span aria-hidden>☰</span>
            <span>{t("workspace.files")}</span>
          </UiButton>
          <UiButton
            className={`icon-toggle ${showPreviewPanel ? "active" : ""}`}
            aria-label={t("workspace.preview")}
            title={t("workspace.preview")}
            onClick={() => setShowPreviewPanel((v) => !v)}
          >
            <span aria-hidden>▭</span>
            <span>{t("workspace.preview")}</span>
          </UiButton>
          <UiButton
            className={`icon-toggle ${showProjectSettingsPanel ? "active" : ""}`}
            aria-label={t("workspace.settings")}
            title={t("workspace.settings")}
            onClick={() => setShowProjectSettingsPanel((v) => !v)}
          >
            <span aria-hidden>⚙</span>
            <span>{t("workspace.settings")}</span>
          </UiButton>
          <UiButton
            className={`icon-toggle ${showRevisionPanel ? "active" : ""}`}
            aria-label={t("workspace.revisions")}
            title={t("workspace.revisions")}
            onClick={toggleRevisionPanel}
          >
            <span aria-hidden>↺</span>
            <span>{t("workspace.revisions")}</span>
          </UiButton>
        </div>
      </div>
    ),
    [
      navigate,
      projectId,
      projects,
      showFilesPanel,
      showPreviewPanel,
      showProjectSettingsPanel,
      showRevisionPanel,
      t
    ]
  );

  useEffect(() => {
    setWorkspaceTopbar(workspaceTopbarControls);
    return () => setWorkspaceTopbar(null);
  }, [setWorkspaceTopbar, workspaceTopbarControls]);

  if (!projectId) return <Navigate to="/projects" replace />;
  if (!project && projects.length > 0) {
    return <Navigate to={`/project/${projects[0].id}`} replace />;
  }
  if (project?.is_template) {
    return (
      <section className="page">
        <UiCard className="template-open-card">
          <h2>{t("projects.useTemplate")}</h2>
          <p>{`${t("projects.copyDialogHint")} ${project.name}`}</p>
          <div className="toolbar">
            <UiButton onClick={() => navigate("/projects")}>{t("nav.backToProjects")}</UiButton>
            <UiButton
              variant="primary"
              onClick={() =>
                setCopyDialog({
                  projectId: project.id,
                  sourceName: project.name,
                  suggestedName: `${project.name} ${t("projects.copySuffix")}`
                })
              }
            >
              {t("projects.copyAction")}
            </UiButton>
          </div>
        </UiCard>
        <UiDialog
          open={!!copyDialog}
          title={t("projects.copyDialogTitle")}
          description={copyDialog ? `${t("projects.copyDialogHint")} ${copyDialog.sourceName}` : undefined}
          onClose={() => setCopyDialog(null)}
          actions={
            <>
              <UiButton onClick={() => setCopyDialog(null)}>{t("common.cancel")}</UiButton>
              <UiButton
                variant="primary"
                onClick={createProjectFromTemplate}
                disabled={copyBusy || !copyDialog?.suggestedName.trim()}
              >
                {copyBusy ? t("projects.copying") : t("projects.copyAction")}
              </UiButton>
            </>
          }
        >
          <UiInput
            value={copyDialog?.suggestedName ?? ""}
            onChange={(e) =>
              setCopyDialog((current) =>
                current
                  ? {
                      ...current,
                      suggestedName: e.target.value
                    }
                  : current
              )
            }
            placeholder={t("projects.namePlaceholder")}
          />
        </UiDialog>
      </section>
    );
  }

  return (
    <section className="workspace-shell">
      {!canWrite && (
        <div className="workspace-access-banner" role="status">
          {t("workspace.readOnlyProject")}
        </div>
      )}
      <section className="workspace-stage">
        {showFilesPanel && (
          <>
            <aside className="panel panel-files" style={{ width: filesPanelWidth }}>
              <div className="panel-header">
                <h2>{t("workspace.files")}</h2>
              </div>
              <div
                className={`panel-content ${filesDropActive ? "drop-active" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                  setFilesDropActive(true);
                }}
                onDragLeave={(event) => {
                  const nextTarget = event.relatedTarget as Node | null;
                  if (!(event.currentTarget as HTMLElement).contains(nextTarget)) {
                    setFilesDropActive(false);
                  }
                }}
                onDrop={onTreeDrop}
              >
                <div className="toolbar compact-left">
                  <UiButton onClick={() => addPath("file")} disabled={!canWrite || isRevisionMode}>
                    <FilePlus2 size={16} />
                    {t("workspace.newFile")}
                  </UiButton>
                  <UiButton onClick={() => addPath("directory")} disabled={!canWrite || isRevisionMode}>
                    <FolderPlus size={16} />
                    {t("workspace.newFolder")}
                  </UiButton>
                  <UiIconButton
                    tooltip={t("workspace.upload")}
                    label={t("workspace.upload")}
                    onClick={() => uploadFromPicker()}
                    disabled={!canWrite || isRevisionMode}
                  >
                    <Upload size={16} />
                  </UiIconButton>
                </div>
                <div className="tree">
                  {tree.map((node) => (
                    <TreeNodeRow
                      key={node.path}
                      node={node}
                      activePath={activePath}
                      expanded={expandedDirs}
                      setExpanded={setExpandedDirs}
                      onOpen={openTreePath}
                      canManage={canWrite && !isRevisionMode}
                      onRequestContextMenu={requestContextMenu}
                    />
                  ))}
                </div>
              </div>
            </aside>
            <div
              className="panel-resizer"
              onMouseDown={beginHorizontalResize((dx) =>
                setFilesPanelWidth(clampNumber(filesPanelWidth + dx, MIN_SIDE_PANEL_WIDTH, MAX_SIDE_PANEL_WIDTH))
              )}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize files panel"
            />
          </>
        )}

        <div className="center-split" ref={centerSplitRef}>
          <article
            className="panel panel-editor"
            style={
              showPreviewPanel
                ? { flex: `${editorRatio} 1 0`, minWidth: 320 }
                : { flex: "1 1 auto", minWidth: 320 }
            }
          >
            <div className="panel-header">
              <h2>{t("workspace.editor")}</h2>
              <div className="panel-status compact">
                <span className="status-pill" title={activePath}>
                  {activeFileName}
                </span>
                <span className="status-pill">
                  {isRevisionMode ? t("status.modeRevision") : t("status.modeLive")}
                </span>
                <span className="status-pill">{t(`status.save${saveState.charAt(0).toUpperCase()}${saveState.slice(1)}`)}</span>
                <span className="status-pill">
                  {compiledAt ? new Date(compiledAt).toLocaleTimeString() : "n/a"}
                </span>
                <button className="inline-toggle" onClick={() => setLineWrapEnabled((value) => !value)}>
                  {lineWrapEnabled ? t("status.wrapOn") : t("status.wrapOff")}
                </button>
                <span className="status-pill" title={remoteCursors.map((user) => user.name).join(", ")}>
                  {`👥 ${remoteCursors.length}`}
                </span>
                <span className={`status-pill ${serverReachable ? "ok" : "warn"}`}>
                  {serverReachable ? "Online" : "Offline"}
                </span>
              </div>
            </div>
            <div className="panel-content flush editor-panel-content">
              {isActiveTextDoc ? (
                <div className="editor-surface">
                  <EditorPane
                    editorInstanceKey={`${activePath}:${activeRevisionId ?? "live"}:${currentEditorLanguage}`}
                    value={docText}
                    onDelta={applyDocumentDeltas}
                    onCursorChange={(cursor) => realtimeRef.current?.sendCursor(cursor)}
                    readOnly={isRevisionMode || !canWrite}
                    lineWrap={lineWrapEnabled}
                    language={currentEditorLanguage}
                    remoteCursors={remoteCursors}
                    jumpTo={jumpTarget}
                    onJumpHandled={() => setJumpTarget(null)}
                  />
                </div>
              ) : (
                <UnsupportedFilePane
                  path={activePath}
                  hasData={!!activeAssetBase64}
                  isImage={isImageAsset(activePath, activeAssetType)}
                  isPdf={isPdfAsset(activePath, activeAssetType)}
                  dataUrl={assetDataUrl}
                  t={t}
                />
              )}
              {!isActiveTextDoc && (
                <div className="error panel-inline-error">
                  {t("workspace.notEditable")}
                </div>
              )}
              {isRevisionMode && !activePathExistsInTree && (
                <div className="error panel-inline-error">This file did not exist in this revision snapshot.</div>
              )}
              {!serverReachable && (
                <div className="error panel-inline-error connection-warning">{t("workspace.connectionLost")}</div>
              )}
              {realtimeRequired && serverReachable && realtimeStatus === "connecting" && (
                <div className="error panel-inline-error connection-warning">
                  {t("workspace.connectionReconnecting")}
                </div>
              )}
              {workspaceError && <div className="error panel-inline-error">{workspaceError}</div>}
            </div>
          </article>

          {showPreviewPanel && (
            <div
              className="panel-resizer"
              onMouseDown={beginHorizontalResize((dx) => {
                const totalWidth = centerSplitRef.current?.getBoundingClientRect().width ?? 1;
                const ratio = clampNumber(editorRatio + dx / Math.max(totalWidth, 1), MIN_EDITOR_RATIO, MAX_EDITOR_RATIO);
                setEditorRatio(ratio);
              })}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize editor and preview"
            />
          )}

          {showPreviewPanel && (
            <aside className="panel panel-preview" style={{ flex: `${1 - editorRatio} 1 0`, minWidth: 280 }}>
              <div className="panel-header">
                <h2>{t("workspace.preview")}</h2>
                <div className="toolbar compact">
                  <UiIconButton
                    tooltip={t("preview.fitWhole")}
                    label={t("preview.fitWhole")}
                    className={previewFitMode === "page" ? "active" : ""}
                    onClick={setPreviewFitWholePage}
                  >
                    ⤢
                  </UiIconButton>
                  <UiIconButton
                    tooltip={t("preview.fitWidth")}
                    label={t("preview.fitWidth")}
                    className={previewFitMode === "width" ? "active" : ""}
                    onClick={setPreviewFitPageWidth}
                  >
                    ↔
                  </UiIconButton>
                  <UiIconButton tooltip={t("preview.zoomOut")} label={t("preview.zoomOut")} onClick={decreasePreviewZoom}>
                    <ZoomOut size={16} />
                  </UiIconButton>
                  <span className="zoom-indicator">{previewPercent}%</span>
                  <UiIconButton tooltip={t("preview.zoomIn")} label={t("preview.zoomIn")} onClick={increasePreviewZoom}>
                    <ZoomIn size={16} />
                  </UiIconButton>
                  <UiIconButton
                    tooltip={t("preview.downloadPdf")}
                    label={t("preview.downloadPdf")}
                    onClick={downloadCompiledPdf}
                    disabled={!pdfData}
                  >
                    <Download size={16} />
                  </UiIconButton>
                  <UiIconButton tooltip={t("preview.downloadZip")} label={t("preview.downloadZip")} onClick={downloadArchive}>
                    <Archive size={16} />
                  </UiIconButton>
                </div>
              </div>
              <div className="panel-content flush">
                {(typstRuntimeStatus.stage === "downloading-compiler" ||
                  (typstRuntimeStatus.stage === "compiling" && !vectorData)) && (
                  <div className="preview-runtime-status">
                    <strong>
                      {typstRuntimeStatus.stage === "downloading-compiler"
                        ? t("preview.loadingCompiler")
                        : t("preview.compiling")}
                    </strong>
                    {typstRuntimeStatus.stage === "downloading-compiler" && (
                      <span>
                        {typstRuntimeStatus.totalBytes && typstRuntimeStatus.totalBytes > 0
                          ? `${Math.round(
                              (100 * (typstRuntimeStatus.loadedBytes || 0)) / typstRuntimeStatus.totalBytes
                            )}%`
                          : `${Math.round((typstRuntimeStatus.loadedBytes || 0) / 1024)} KB`}
                      </span>
                    )}
                  </div>
                )}
                <div
                  ref={canvasPreviewRef}
                  className={`pdf-frame ${previewIsPanning ? "is-panning" : ""}`}
                  onMouseDown={beginPreviewPan}
                />
                {compileDiagnostics.length > 0 && (
                  <div className="panel-inline-error diagnostics">
                    {compileDiagnostics.map((diagnostic, index) => (
                      <button
                        key={`${diagnostic.raw}-${index}`}
                        className="diagnostic-item"
                        onClick={() => jumpToDiagnostic(diagnostic)}
                      >
                        <span className={`diagnostic-level ${diagnostic.severity}`}>{diagnostic.severity}</span>
                        <span className="diagnostic-main">
                          {diagnostic.path
                            ? `${diagnostic.path}:${diagnostic.line ?? 1}:${diagnostic.column ?? 1}`
                            : "workspace"}
                          {" — "}
                          {diagnostic.message}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {compileDiagnostics.length === 0 && compileErrors.length > 0 && (
                  <div className="error panel-inline-error">{compileErrors.join("; ")}</div>
                )}
              </div>
            </aside>
          )}
        </div>

        {showProjectSettingsPanel && (
          <>
            <div
              className="panel-resizer"
              onMouseDown={beginHorizontalResize((dx) =>
                setSettingsPanelWidth(clampNumber(settingsPanelWidth - dx, MIN_SIDE_PANEL_WIDTH, MAX_SIDE_PANEL_WIDTH))
              )}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize project settings panel"
            />
            <aside className="panel panel-settings" style={{ width: settingsPanelWidth }}>
              <div className="panel-header">
                <h2>{t("workspace.settings")}</h2>
              </div>
              <div className="panel-content">
                <div className="settings-section">
                  <strong>{t("settings.compilation")}</strong>
                  <label>
                    {t("settings.entryFile")}
                    <UiSelect
                      value={entryFilePath}
                      onChange={async (e) => {
                        const next = e.target.value.trim();
                        if (!next) return;
                        const updated = await upsertProjectSettings(projectId, next);
                        setEntryFilePath(updated.entry_file_path);
                      }}
                      disabled={!canManageProject}
                    >
                      {typEntryOptions.map((path) => (
                        <option value={path} key={path}>
                          {path}
                        </option>
                      ))}
                    </UiSelect>
                  </label>
                  <small>{t("settings.entryFileHint")}</small>
                </div>
                <div className="settings-section">
                  <strong>{t("settings.gitAccess")}</strong>
                  <code>{gitRepoUrl || t("common.loading")}</code>
                  <div className="toolbar compact-left">
                    <UiButton
                      size="sm"
                      onClick={() => copyToClipboard("git-access-url", gitRepoUrl)}
                      disabled={!gitRepoUrl}
                    >
                      {copiedControl === "git-access-url" ? t("share.copied") : t("share.copy")}
                    </UiButton>
                  </div>
                  <small>{t("settings.gitHint")}</small>
                </div>
                <div className="settings-section">
                  <strong>{t("settings.templateTitle")}</strong>
                  <div className="toolbar compact-left">
                    <UiButton
                      variant={templateEnabled ? "primary" : "secondary"}
                      onClick={() => setTemplateState(!templateEnabled)}
                      disabled={!canManageProject}
                    >
                      {templateEnabled ? t("settings.templateEnabled") : t("settings.templateDisabled")}
                    </UiButton>
                  </div>
                  <small>{t("settings.templateHint")}</small>
                  {templateEnabled && (
                    <div className="card-list">
                      {myOrganizations.length > 0 ? (
                        myOrganizations.map((org) => {
                          const granted = projectTemplateOrgAccess.some(
                            (item) => item.organization_id === org.organization_id
                          );
                          return (
                            <div className="card" key={`tpl-${org.organization_id}`}>
                              <strong>{org.organization_name}</strong>
                              <div className="toolbar compact-left">
                                {granted ? (
                                  <UiButton
                                    size="sm"
                                    variant="danger"
                                    onClick={() => removeTemplateOrgAccessGrant(org.organization_id)}
                                    disabled={!canManageProject}
                                  >
                                    {t("common.revoke")}
                                  </UiButton>
                                ) : (
                                  <UiButton
                                    size="sm"
                                    onClick={() => upsertTemplateOrgAccessGrant(org.organization_id)}
                                    disabled={!canManageProject}
                                  >
                                    {t("settings.templateGrant")}
                                  </UiButton>
                                )}
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <small>{t("projects.noOrganizations")}</small>
                      )}
                    </div>
                  )}
                </div>
                <div className="settings-section">
                  <strong>{t("share.title")}</strong>
                  <div className="settings-share-grid">
                    <div className="card">
                      <strong>{t("share.readLink")}</strong>
                      <div className="toolbar compact-left">
                        {activeReadShare ? (
                          <UiButton
                            onClick={() => revokeShare(activeReadShare.id)}
                            disabled={!canManageProject}
                          >
                            {t("common.disable")}
                          </UiButton>
                        ) : (
                          <UiButton onClick={() => createShare("read")} disabled={!canManageProject}>
                            {t("common.enable")}
                          </UiButton>
                        )}
                      </div>
                      {activeReadShare?.token_value ? (
                        <>
                          <code>{`${window.location.origin}/share/${activeReadShare.token_value}`}</code>
                          <UiButton
                            onClick={async () => {
                              await copyToClipboard(
                                "share-read-link",
                                `${window.location.origin}/share/${activeReadShare.token_value}`
                              );
                            }}
                          >
                            {copiedControl === "share-read-link" ? t("share.copied") : t("share.copy")}
                          </UiButton>
                        </>
                      ) : (
                        <small>{t("share.none")}</small>
                      )}
                    </div>
                    <div className="card">
                      <strong>{t("share.writeLink")}</strong>
                      <div className="toolbar compact-left">
                        {activeWriteShare ? (
                          <UiButton
                            onClick={() => revokeShare(activeWriteShare.id)}
                            disabled={!canManageProject}
                          >
                            {t("common.disable")}
                          </UiButton>
                        ) : (
                          <UiButton onClick={() => createShare("write")} disabled={!canManageProject}>
                            {t("common.enable")}
                          </UiButton>
                        )}
                      </div>
                      {activeWriteShare?.token_value ? (
                        <>
                          <code>{`${window.location.origin}/share/${activeWriteShare.token_value}`}</code>
                          <UiButton
                            onClick={async () => {
                              await copyToClipboard(
                                "share-write-link",
                                `${window.location.origin}/share/${activeWriteShare.token_value}`
                              );
                            }}
                          >
                            {copiedControl === "share-write-link" ? t("share.copied") : t("share.copy")}
                          </UiButton>
                        </>
                      ) : (
                        <small>{t("share.none")}</small>
                      )}
                    </div>
                  </div>
                </div>
                <div className="settings-section">
                  <strong>{t("settings.organizationAccess")}</strong>
                  {myOrganizations.length > 0 ? (
                    <div className="card-list">
                      {myOrganizations.map((org) => {
                        const existing = projectOrgAccess.find((item) => item.organization_id === org.organization_id);
                        return (
                          <div className="card" key={org.organization_id}>
                            <strong>{org.organization_name}</strong>
                            <UiSelect
                              value={existing?.permission ?? ""}
                              onChange={(e) => {
                                const value = e.target.value;
                                if (value === "read" || value === "write") {
                                  upsertOrgAccessGrant(org.organization_id, value);
                                } else {
                                  removeOrgAccessGrant(org.organization_id);
                                }
                              }}
                              disabled={!canManageProject}
                            >
                              <option value="">{t("settings.noAccess")}</option>
                              <option value="read">{t("settings.readOnly")}</option>
                              <option value="write">{t("settings.readWrite")}</option>
                            </UiSelect>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <small>{t("projects.noOrganizations")}</small>
                  )}
                </div>
                <div className="settings-section">
                  <strong>{t("settings.projectUsers")}</strong>
                  {projectAccessUsers.length > 0 ? (
                    <div className="card-list">
                      {projectAccessUsers.map((user) => (
                        <div className="card" key={user.user_id}>
                          <strong>{user.display_name || user.email}</strong>
                          <span>{user.email}</span>
                          <span>{`${t("settings.accessType")}: ${formatAccessType(user.access_type, user.role)}`}</span>
                          <span>{`${t("settings.role")}: ${formatRoleLabel(user.role)}`}</span>
                          <span>{`${t("settings.source")}: ${user.sources.map((source) => formatAccessSource(source)).join(", ")}`}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <small>{t("settings.noUsers")}</small>
                  )}
                </div>
              </div>
            </aside>
          </>
        )}

        {showRevisionPanel && (
          <>
            <div
              className="panel-resizer"
              onMouseDown={beginHorizontalResize((dx) =>
                setRevisionsPanelWidth(
                  clampNumber(revisionsPanelWidth - dx, MIN_SIDE_PANEL_WIDTH, MAX_SIDE_PANEL_WIDTH)
                )
              )}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize revisions panel"
            />
            <aside className="panel panel-revisions" style={{ width: revisionsPanelWidth }}>
              <div className="panel-header">
                <h2>{t("workspace.revisions")}</h2>
              </div>
              <div className="panel-content">
                <HistoryPanel
                  revisions={revisions.map((revision) => ({
                    id: revision.id,
                    summary: revision.summary,
                    createdAt: revision.created_at,
                    author:
                      revision.authors.length > 0
                        ? revision.authors.map((author) => author.display_name).join(", ")
                        : revision.actor_user_id || "Unknown"
                  }))}
                  selectedId={activeRevisionId}
                  onSelect={openRevision}
                />
              </div>
            </aside>
          </>
        )}
      </section>

      {contextMenu && canWrite && (
        <div
          className="context-menu context-menu-floating"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.kind === "directory" && (
            <UiButton className="mini" size="sm" onClick={() => addPath("file", contextMenu.path)}>
              {t("workspace.newFile")}
            </UiButton>
          )}
          {contextMenu.kind === "directory" && (
            <UiButton className="mini" size="sm" onClick={() => addPath("directory", contextMenu.path)}>
              {t("workspace.newFolder")}
            </UiButton>
          )}
          {contextMenu.kind === "directory" && (
            <UiButton className="mini" size="sm" onClick={() => uploadFromPicker(contextMenu.path)}>
              {t("workspace.upload")}
            </UiButton>
          )}
          <UiButton className="mini" size="sm" onClick={() => renamePath(contextMenu.path)}>
            {t("common.rename")}
          </UiButton>
          <UiButton className="mini" size="sm" variant="danger" onClick={() => removePath(contextMenu.path)}>
            {t("common.delete")}
          </UiButton>
        </div>
      )}
      <UiDialog
        open={!!pathDialog}
        title={
          pathDialog?.mode === "create"
            ? pathDialog.kind === "file"
              ? t("workspace.newFile")
              : t("workspace.newFolder")
            : pathDialog?.mode === "rename"
              ? t("common.rename")
              : t("common.delete")
        }
        description={
          pathDialog?.mode === "delete"
            ? `${t("settings.deletePathConfirm")} ${pathDialog.path}`
            : undefined
        }
        onClose={() => setPathDialog(null)}
        actions={
          <>
            <UiButton onClick={() => setPathDialog(null)}>{t("common.cancel")}</UiButton>
            <UiButton
              variant={pathDialog?.mode === "delete" ? "danger" : "primary"}
              onClick={submitPathDialog}
              disabled={
                !!pathDialog &&
                pathDialog.mode !== "delete" &&
                !pathDialog.value.trim()
              }
            >
              {pathDialog?.mode === "delete" ? t("common.delete") : t("common.save")}
            </UiButton>
          </>
        }
      >
        {pathDialog && pathDialog.mode !== "delete" && (
          <UiInput
            value={pathDialog.value}
            onChange={(event) =>
              setPathDialog((current) => {
                if (!current || current.mode === "delete") return current;
                return {
                  ...current,
                  value: event.target.value
                };
              })
            }
            placeholder={t("workspace.pathPlaceholder")}
          />
        )}
      </UiDialog>
    </section>
  );
}

function ShareJoinPage({
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

function UnsupportedFilePane({
  path,
  hasData,
  isImage,
  isPdf,
  dataUrl,
  t
}: {
  path: string;
  hasData: boolean;
  isImage: boolean;
  isPdf: boolean;
  dataUrl: string;
  t: (key: string) => string;
}) {
  const downloadName = path.split("/").filter(Boolean).pop() || path;
  const media = isImage ? (
    <img src={dataUrl} alt={path} className="file-preview-image" />
  ) : isPdf ? (
    <iframe title={path} src={dataUrl} className="file-preview-pdf" />
  ) : (
    <div className="file-icon" aria-hidden />
  );

  if (!hasData) {
    return (
      <div className="file-preview file-preview-asset">
        <div className="file-preview-media">
          <div className="file-icon" aria-hidden />
        </div>
        <div className="file-preview-meta">
          <div className="file-preview-name">{path}</div>
          <small>File content is loading.</small>
        </div>
      </div>
    );
  }
  return (
    <div className="file-preview file-preview-asset">
      <div className="file-preview-media">{media}</div>
      <div className="file-preview-meta">
        <div className="file-preview-name">{downloadName}</div>
        <small className="muted">{path}</small>
        <a className="ui-icon-button" href={dataUrl} download={downloadName} title={t("workspace.download")} aria-label={t("workspace.download")}>
          <Download size={16} />
        </a>
      </div>
    </div>
  );
}

function TreeNodeRow({
  node,
  activePath,
  expanded,
  setExpanded,
  onOpen,
  canManage,
  onRequestContextMenu
}: {
  node: ProjectTreeNodeView;
  activePath: string;
  expanded: Set<string>;
  setExpanded: (next: Set<string>) => void;
  onOpen: (path: string) => void;
  canManage: boolean;
  onRequestContextMenu: (menu: ContextMenuState) => void;
}) {
  const isExpanded = expanded.has(node.path);
  const isActive = activePath === node.path;
  const toggleDirectory = () => {
    if (node.kind !== "directory") return;
    const next = new Set(expanded);
    if (isExpanded) next.delete(node.path);
    else next.add(node.path);
    setExpanded(next);
  };
  return (
    <div className="tree-branch">
      <div
        className={`tree-node ${isActive ? "active" : ""}`}
        onContextMenu={(event) => {
          if (!canManage) return;
          event.preventDefault();
          onRequestContextMenu({
            path: node.path,
            kind: node.kind,
            x: event.clientX,
            y: event.clientY
          });
        }}
      >
        {node.kind === "directory" ? (
          <button className="tree-toggle" onClick={toggleDirectory}>
            {isExpanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-toggle tree-placeholder" />
        )}
        <button
          className="tree-label"
          onClick={() => (node.kind === "file" ? onOpen(node.path) : toggleDirectory())}
        >
          <span className={`tree-kind ${node.kind}`}>{node.kind === "directory" ? "Dir" : "File"}</span>
          <span className="tree-name">{node.name}</span>
        </button>
        {canManage && (
          <button
            className="mini"
            onClick={(event) => {
              event.stopPropagation();
              const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
              onRequestContextMenu({
                path: node.path,
                kind: node.kind,
                x: Math.round(rect.left),
                y: Math.round(rect.bottom + 4)
              });
            }}
          >
            ⋮
          </button>
        )}
      </div>
      {node.kind === "directory" && isExpanded && node.children.length > 0 && (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              activePath={activePath}
              expanded={expanded}
              setExpanded={setExpanded}
              onOpen={onOpen}
              canManage={canManage}
              onRequestContextMenu={onRequestContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}
