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
  createProjectShareLink,
  createProjectFile,
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
  getProjectTree,
  getRevisionDocuments,
  listDocuments,
  listMyOrganizations,
  listOrgGroupRoleMappings,
  listPersonalAccessTokens,
  listProjectAccessUsers,
  listProjectAssets,
  listProjectOrganizationAccess,
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
  type ProjectShareLink,
  type Revision,
  moveProjectFile,
  upsertAdminAuthSettings,
  upsertDocumentByPath,
  upsertOrgGroupRoleMapping,
  upsertProjectOrganizationAccess,
  upsertProjectSettings,
  uploadProjectAsset
} from "@/lib/api";
import { readStoredLocale, translate, type UiLocale } from "@/lib/i18n";
import { loadProjectSnapshotFromCache, saveProjectSnapshotToCache } from "@/lib/projectCache";

type ProjectTreeNodeView = {
  name: string;
  path: string;
  kind: "file" | "directory";
  children: ProjectTreeNodeView[];
};

type AssetMeta = {
  id: string;
  contentType: string;
};

type ContextMenuState = {
  path: string;
  kind: "file" | "directory";
  x: number;
  y: number;
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

function formatRelativeTime(iso: string) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const diffMs = Date.now() - at;
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;
  const rawValue =
    abs < hour
      ? Math.round(abs / minute)
      : abs < day
        ? Math.round(abs / hour)
        : abs < week
          ? Math.round(abs / day)
          : abs < month
            ? Math.round(abs / week)
            : abs < year
              ? Math.round(abs / month)
              : Math.round(abs / year);
  const value = Math.max(1, rawValue);
  const unit =
    abs < hour
      ? "minute"
      : abs < day
        ? "hour"
        : abs < week
          ? "day"
          : abs < month
            ? "week"
            : abs < year
              ? "month"
              : "year";
  const formatter = new Intl.RelativeTimeFormat(readStoredLocale() === "zh-CN" ? "zh-CN" : "en", {
    numeric: "auto"
  });
  return formatter.format(diffMs >= 0 ? -value : value, unit as Intl.RelativeTimeFormatUnit);
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
        transformWrapper.style.transform = `scale(${zoom})`;
      }
    }
    surface.style.width = `${nextWidth}px`;
    surface.style.height = `${nextHeight}px`;
    widest = Math.max(widest, nextWidth);
  }
  pages.style.width = `${Math.max(widest, 1)}px`;
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
          <Link className="tab" to="/projects">
            {t("nav.backToProjects")}
          </Link>
        )}
        <div className="topbar-workspace-slot">{onWorkspaceRoute ? workspaceTopbar : null}</div>
        <div className="meta">
          {!onWorkspaceRoute && (
            <>
              <Link className={`tab ${onProjectsRoute ? "active" : ""}`} to="/projects">
                {t("nav.projects")}
              </Link>
              <Link className={`tab ${onProfileRoute ? "active" : ""}`} to="/profile">
                {t("nav.profile")}
              </Link>
              {hasOrgAdminAccess && (
                <Link className={`tab ${onAdminRoute ? "active" : ""}`} to="/admin">
                  {t("nav.admin")}
                </Link>
              )}
            </>
          )}
          <span>{authUser.display_name}</span>
          <button className="button" onClick={handleLogout}>
            {t("nav.logout")}
          </button>
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

function SignInPage({
  config,
  t,
  onSignedIn
}: {
  config: AuthConfig | null;
  t: (key: string) => string;
  onSignedIn: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    try {
      setError(null);
      if (mode === "login") {
        await localLogin(email.trim(), password);
      } else {
        await localRegister({
          email: email.trim(),
          password,
          display_name: displayName.trim() || undefined
        });
      }
      await onSignedIn();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Authentication failed";
      setError(message);
    }
  }

  return (
    <section className="auth-shell">
      <div className="auth-card">
        <h2>{t("auth.signIn")}</h2>
        <p>{t("auth.subtitle")}</p>
        <div className="toolbar">
          <button className={`button ${mode === "login" ? "filled" : ""}`} onClick={() => setMode("login")}>
            {t("auth.localLogin")}
          </button>
          {config?.allow_local_registration && (
            <button className={`button ${mode === "register" ? "filled" : ""}`} onClick={() => setMode("register")}>
              {t("auth.register")}
            </button>
          )}
          {config?.allow_oidc && (
            <a className="button" href={oidcLoginUrl()}>
              {t("auth.oidcLogin")}
            </a>
          )}
        </div>
        <div className="auth-fields">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
          <input
            value={password}
            type="password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
          />
          {mode === "register" && (
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name (optional)"
            />
          )}
          <button className="button filled" onClick={submit} disabled={!email || !password}>
            {t("auth.continue")}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}

function ProjectsPage({
  projects,
  organizations,
  refreshProjects,
  t
}: {
  projects: Project[];
  organizations: OrganizationMembership[];
  refreshProjects: () => Promise<void>;
  t: (key: string) => string;
}) {
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filteredProjects = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return projects
      .filter((project) => (view === "archived" ? project.archived : !project.archived))
      .filter((project) => {
        if (!keyword) return true;
        return (
          project.name.toLowerCase().includes(keyword) ||
          project.owner_display_name.toLowerCase().includes(keyword)
        );
      })
      .sort((a, b) => Date.parse(b.last_edited_at) - Date.parse(a.last_edited_at));
  }, [projects, search, view]);

  return (
    <section className="page projects-page">
      <div className="projects-title-row">
        <h2>{t("projects.title")}</h2>
      </div>
      <div className="card projects-create-bar">
        <strong>{t("projects.createTitle")}</strong>
        <div className="projects-create-controls">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("projects.namePlaceholder")} />
          <button
            className="button"
            onClick={async () => {
              if (!name.trim()) return;
              try {
                setError(null);
                await createProject({ name: name.trim() });
                setName("");
                await refreshProjects();
              } catch (err) {
                const message = err instanceof Error ? err.message : "Unable to create project";
                setError(message);
              }
            }}
          >
            {t("projects.createAction")}
          </button>
        </div>
      </div>
      <div className="card projects-controls">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("projects.searchPlaceholder")}
          aria-label="Search projects"
        />
        <div className="toolbar compact-left">
          <button className={`button ${view === "active" ? "filled" : ""}`} onClick={() => setView("active")}>
            {t("projects.active")}
          </button>
          <button className={`button ${view === "archived" ? "filled" : ""}`} onClick={() => setView("archived")}>
            {t("projects.archived")}
          </button>
        </div>
      </div>
      <div className="card projects-table-shell">
        <div className="projects-table-scroll">
          <table className="projects-table">
            <thead>
              <tr>
                <th>{t("projects.tableTitle")}</th>
                <th>{t("projects.tableOwner")}</th>
                <th>{t("projects.tableLastEdited")}</th>
                <th className="align-right">{t("projects.tableActions")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredProjects.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link to={`/project/${project.id}`} className="project-title-link">
                      {project.name}
                    </Link>
                  </td>
                  <td>{project.owner_display_name}</td>
                  <td title={new Date(project.last_edited_at).toLocaleString()}>{formatRelativeTime(project.last_edited_at)}</td>
                  <td className="align-right">
                    <div className="projects-row-actions">
                      <Link className="button button-small" to={`/project/${project.id}`}>
                        {t("projects.open")}
                      </Link>
                      <button
                        className="button button-small"
                        disabled={busyProjectId === project.id}
                        onClick={async () => {
                          try {
                            setError(null);
                            setBusyProjectId(project.id);
                            await setProjectArchived(project.id, !project.archived);
                            await refreshProjects();
                          } catch (err) {
                            const message =
                              err instanceof Error
                                ? err.message
                                : project.archived
                                  ? "Unable to unarchive project"
                                  : "Unable to archive project";
                            setError(message);
                          } finally {
                            setBusyProjectId(null);
                          }
                        }}
                      >
                        {project.archived ? t("projects.unarchive") : t("projects.archive")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredProjects.length === 0 && (
                <tr>
                  <td colSpan={4} className="projects-empty">
                    {t("projects.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card projects-org-memberships">
        <strong>{t("projects.organizations")}</strong>
        <div className="projects-org-list">
          {organizations.length > 0 ? (
            organizations.map((org) => (
              <span key={org.organization_id} className="org-pill">
                {org.organization_name}
              </span>
            ))
          ) : (
            <span className="muted">{t("projects.noOrganizations")}</span>
          )}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}

function WorkspacePage({
  projects,
  organizations,
  authUser,
  t
}: {
  projects: Project[];
  organizations: OrganizationMembership[];
  authUser: AuthUser;
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
  const lastSavedDocRef = useRef<string>("");
  const copyNoticeTimerRef = useRef<number | null>(null);

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
  const [lineWrapEnabled, setLineWrapEnabled] = useState(true);
  const [jumpTarget, setJumpTarget] = useState<{ line: number; column: number; token: number } | null>(null);
  const [queuedJump, setQueuedJump] = useState<{ path: string; line: number; column: number } | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set([""]));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [filesDropActive, setFilesDropActive] = useState(false);
  const [bundledFonts, setBundledFonts] = useState<Uint8Array[]>([]);
  const [shareLinks, setShareLinks] = useState<ProjectShareLink[]>([]);
  const [projectOrgAccess, setProjectOrgAccess] = useState<ProjectOrganizationAccess[]>([]);
  const [projectAccessUsers, setProjectAccessUsers] = useState<ProjectAccessUser[]>([]);
  const [typstRuntimeStatus, setTypstRuntimeStatus] = useState<TypstRuntimeStatus>({ stage: "idle" });
  const [apiReachable, setApiReachable] = useState(true);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting");
  const [copiedControl, setCopiedControl] = useState<string | null>(null);

  const tree = useMemo(() => projectTreeFromFlat(nodes), [nodes]);
  const isRevisionMode = !!activeRevisionId;
  const hasActiveDoc = Object.prototype.hasOwnProperty.call(docs, activePath);
  const isActiveTextDoc = isRevisionMode
    ? Object.prototype.hasOwnProperty.call(revisionDocs, activePath)
    : hasActiveDoc;
  const sourceDocs = isRevisionMode ? revisionDocs : docs;
  const compileDocuments = useMemo(() => {
    const baseDocs = { ...sourceDocs };
    if (!isRevisionMode && activePath && activePath in baseDocs) {
      baseDocs[activePath] = docText;
    }
    return Object.entries(baseDocs).map(([path, content]) => ({ path, content }));
  }, [activePath, docText, isRevisionMode, sourceDocs]);
  const compileAssets = useMemo(
    () => Object.entries(assetBase64).map(([path, contentBase64]) => ({ path, contentBase64 })),
    [assetBase64]
  );
  const assetFontData = useMemo(
    () =>
      Object.entries(assetBase64)
        .filter(([path]) => isFontFile(path))
        .map(([, b64]) => {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          return bytes;
        }),
    [assetBase64]
  );
  const fontData = useMemo(() => [...bundledFonts, ...assetFontData], [assetFontData, bundledFonts]);
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
  const activeAsset = assetMeta[activePath];
  const activeAssetBase64 = assetBase64[activePath];
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
  const previewPercent = Math.round(previewZoom * 100);
  const activeFileName = activePath.split("/").filter(Boolean).at(-1) || activePath;
  const realtimeRequired = isActiveTextDoc && !isRevisionMode;
  const serverReachable = apiReachable && (!realtimeRequired || realtimeStatus !== "disconnected");

  const refreshProjectData = async () => {
    if (!projectId) return;
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
    let [treeRes, settings, git, docsRes, revisionsRes, assetsRes, shareRes, orgAccessRes, accessUsersRes] = responseTuple;
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
    setCompileErrors([]);
    setCompileDiagnostics([]);
    setVectorData(null);
    setPdfData(null);
    setCompiledAt(null);
    setPresence([]);
    setDocText("");
    setContextMenu(null);
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
      listProjectAccessUsers(projectId).then((res) => res.users).catch(() => [])
    ])
      .then(([shares, orgAccess, users]) => {
        setShareLinks(shares);
        setProjectOrgAccess(orgAccess);
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
    let cancelled = false;
    fetch("/typst-fonts/NotoSans-Regular.ttf")
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .then((buf) => {
        if (cancelled || !buf) return;
        setBundledFonts([new Uint8Array(buf)]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
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
    if (!hasActiveDoc) {
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
    hasActiveDoc,
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
    if (!hasActiveDoc) return;
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
  }, [activePath, docText, hasActiveDoc, isRevisionMode, projectId, workspaceLoaded]);

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
        entryFilePath,
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
  }, [compileAssets, compileDocuments, entryFilePath, fontData, projectId, workspaceLoaded]);

  useEffect(() => {
    if (!showPreviewPanel) return;
    const frame = canvasPreviewRef.current;
    if (!frame) return;
    if (!vectorData) {
      setPreviewRenderTick((value) => value + 1);
      return;
    }
    let cancelled = false;
    renderTypstVectorToCanvas(frame, vectorData)
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
  }, [showPreviewPanel, vectorData]);

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

  async function addPath(kind: "file" | "directory", parentPath = "") {
    if (!projectId || !canWrite) return;
    const placeholder = kind === "file" ? "untitled.typ" : "folder";
    const suggested = joinProjectPath(parentPath, placeholder);
    const raw = window.prompt(kind === "file" ? "New file path" : "New directory path", suggested);
    if (!raw) return;
    let normalized = normalizePath(raw);
    if (parentPath && !normalized.includes("/")) {
      normalized = joinProjectPath(parentPath, normalized);
    }
    try {
      setContextMenu(null);
      await createProjectFile(projectId, {
        path: normalized,
        kind,
        content: kind === "file" ? "" : undefined
      });
      await refreshProjectData();
      if (kind === "file") setActivePath(normalized);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to create path";
      setWorkspaceError(message);
    }
  }

  async function renamePath(path: string) {
    if (!projectId || !canWrite) return;
    const to = window.prompt("Rename to", path);
    if (!to) return;
    let normalizedTo = normalizePath(to);
    const parentPath = parentProjectPath(path);
    if (parentPath && !normalizedTo.includes("/")) {
      normalizedTo = joinProjectPath(parentPath, normalizedTo);
    }
    if (normalizedTo === path) return;
    try {
      await moveProjectFile(projectId, path, normalizedTo);
      setContextMenu(null);
      await refreshProjectData();
      if (activePath === path) setActivePath(normalizedTo);
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to rename path";
      setWorkspaceError(message);
    }
  }

  async function removePath(path: string) {
    if (!projectId || !canWrite) return;
    if (!window.confirm(`Delete ${path}?`)) return;
    try {
      await deleteProjectFile(projectId, path);
      setContextMenu(null);
      if (activePath === path) setActivePath(entryFilePath);
      await refreshProjectData();
      setWorkspaceError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to delete path";
      setWorkspaceError(message);
    }
  }

  type UploadCandidate = {
    relativePath: string;
    file: File;
  };

  async function commitUploads(items: UploadCandidate[], parentPath = "") {
    if (!projectId || items.length === 0 || !canWrite) return;
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
    if (!canWrite) return;
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
    if (!canWrite) return;
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

  async function openRevision(revisionId: string) {
    if (!projectId) return;
    if (activeRevisionId === revisionId) {
      setActiveRevisionId(null);
      setRevisionDocs({});
      return;
    }
    const response = await getRevisionDocuments(projectId, revisionId);
    const map: Record<string, string> = {};
    for (const doc of response.documents) map[doc.path] = doc.content;
    setRevisionDocs(map);
    setActiveRevisionId(revisionId);
  }

  function downloadCompiledPdf() {
    if (!pdfData) return;
    const safeBytes = new Uint8Array(Array.from(pdfData));
    const blob = new Blob([safeBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = entryFilePath.replace(/\.typ$/i, "") + ".pdf";
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

  const workspaceTopbarControls = useMemo(
    () => (
      <div className="workspace-topbar-controls">
        <label className="workspace-project-picker workspace-topbar-project" aria-label={t("nav.projects")}>
          <select value={projectId} onChange={(e) => navigate(`/project/${e.target.value}`)}>
            {projects.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <div className="workspace-icon-toggles">
          <button
            className={`icon-toggle ${showFilesPanel ? "active" : ""}`}
            aria-label={t("workspace.files")}
            title={t("workspace.files")}
            onClick={() => setShowFilesPanel((v) => !v)}
          >
            <span aria-hidden>☰</span>
            <span>{t("workspace.files")}</span>
          </button>
          <button
            className={`icon-toggle ${showPreviewPanel ? "active" : ""}`}
            aria-label={t("workspace.preview")}
            title={t("workspace.preview")}
            onClick={() => setShowPreviewPanel((v) => !v)}
          >
            <span aria-hidden>▭</span>
            <span>{t("workspace.preview")}</span>
          </button>
          <button
            className={`icon-toggle ${showProjectSettingsPanel ? "active" : ""}`}
            aria-label={t("workspace.settings")}
            title={t("workspace.settings")}
            onClick={() => setShowProjectSettingsPanel((v) => !v)}
          >
            <span aria-hidden>⚙</span>
            <span>{t("workspace.settings")}</span>
          </button>
          <button
            className={`icon-toggle ${showRevisionPanel ? "active" : ""}`}
            aria-label={t("workspace.revisions")}
            title={t("workspace.revisions")}
            onClick={toggleRevisionPanel}
          >
            <span aria-hidden>↺</span>
            <span>{t("workspace.revisions")}</span>
          </button>
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
                  <button className="button" onClick={() => addPath("file")} disabled={!canWrite}>
                    {t("workspace.newFile")}
                  </button>
                  <button className="button" onClick={() => addPath("directory")} disabled={!canWrite}>
                    {t("workspace.newFolder")}
                  </button>
                  <button className="button" onClick={() => uploadFromPicker()} disabled={!canWrite}>
                    {t("workspace.upload")}
                  </button>
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
                      canManage={canWrite}
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
                    value={docText}
                    onDelta={applyDocumentDeltas}
                    onCursorChange={(cursor) => realtimeRef.current?.sendCursor(cursor)}
                    readOnly={isRevisionMode || !canWrite}
                    lineWrap={lineWrapEnabled}
                    language={editorLanguageForPath(activePath)}
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
              {isRevisionMode && !Object.prototype.hasOwnProperty.call(revisionDocs, activePath) && (
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
                  <button
                    className={`icon-button ${previewFitMode === "page" ? "filled" : ""}`}
                    title="Fit Whole Page"
                    aria-label="Fit Whole Page"
                    onClick={setPreviewFitWholePage}
                  >
                    ⤢
                  </button>
                  <button
                    className={`icon-button ${previewFitMode === "width" ? "filled" : ""}`}
                    title="Fit Page Width"
                    aria-label="Fit Page Width"
                    onClick={setPreviewFitPageWidth}
                  >
                    ↔
                  </button>
                  <button
                    className="icon-button"
                    title="Zoom Out"
                    aria-label="Zoom Out"
                    onClick={decreasePreviewZoom}
                  >
                    －
                  </button>
                  <span className="zoom-indicator">{previewPercent}%</span>
                  <button
                    className="icon-button"
                    title="Zoom In"
                    aria-label="Zoom In"
                    onClick={increasePreviewZoom}
                  >
                    ＋
                  </button>
                  <button
                    className="icon-button"
                    title={t("preview.downloadPdf")}
                    aria-label={t("preview.downloadPdf")}
                    onClick={downloadCompiledPdf}
                    disabled={!pdfData}
                  >
                    ↓PDF
                  </button>
                  <button
                    className="icon-button"
                    title={t("preview.downloadZip")}
                    aria-label={t("preview.downloadZip")}
                    onClick={downloadArchive}
                  >
                    ↓ZIP
                  </button>
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
                <div ref={canvasPreviewRef} className="pdf-frame" />
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
                  <strong>Compilation</strong>
                  <label>
                    Entry file
                    <select
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
                    </select>
                  </label>
                  <small>Preview and PDF export compile from this file.</small>
                </div>
                <div className="settings-section">
                  <strong>Git access</strong>
                  <code>{gitRepoUrl || "Loading..."}</code>
                  <div className="toolbar compact-left">
                    <button
                      className="button button-small"
                      onClick={() => copyToClipboard("git-access-url", gitRepoUrl)}
                      disabled={!gitRepoUrl}
                    >
                      {copiedControl === "git-access-url" ? t("share.copied") : t("share.copy")}
                    </button>
                  </div>
                  <small>Use PAT as HTTP password. Force push is rejected.</small>
                </div>
                <div className="settings-section">
                  <strong>{t("share.title")}</strong>
                  <div className="settings-share-grid">
                    <div className="card">
                      <strong>Read link</strong>
                      <div className="toolbar compact-left">
                        {activeReadShare ? (
                          <button
                            className="button"
                            onClick={() => revokeShare(activeReadShare.id)}
                            disabled={!canManageProject}
                          >
                            Disable
                          </button>
                        ) : (
                          <button className="button" onClick={() => createShare("read")} disabled={!canManageProject}>
                            Enable
                          </button>
                        )}
                      </div>
                      {activeReadShare?.token_value ? (
                        <>
                          <code>{`${window.location.origin}/share/${activeReadShare.token_value}`}</code>
                          <button
                            className="button"
                            onClick={async () => {
                              await copyToClipboard(
                                "share-read-link",
                                `${window.location.origin}/share/${activeReadShare.token_value}`
                              );
                            }}
                          >
                            {copiedControl === "share-read-link" ? t("share.copied") : t("share.copy")}
                          </button>
                        </>
                      ) : (
                        <small>{t("share.none")}</small>
                      )}
                    </div>
                    <div className="card">
                      <strong>Write link</strong>
                      <div className="toolbar compact-left">
                        {activeWriteShare ? (
                          <button
                            className="button"
                            onClick={() => revokeShare(activeWriteShare.id)}
                            disabled={!canManageProject}
                          >
                            Disable
                          </button>
                        ) : (
                          <button className="button" onClick={() => createShare("write")} disabled={!canManageProject}>
                            Enable
                          </button>
                        )}
                      </div>
                      {activeWriteShare?.token_value ? (
                        <>
                          <code>{`${window.location.origin}/share/${activeWriteShare.token_value}`}</code>
                          <button
                            className="button"
                            onClick={async () => {
                              await copyToClipboard(
                                "share-write-link",
                                `${window.location.origin}/share/${activeWriteShare.token_value}`
                              );
                            }}
                          >
                            {copiedControl === "share-write-link" ? t("share.copied") : t("share.copy")}
                          </button>
                        </>
                      ) : (
                        <small>{t("share.none")}</small>
                      )}
                    </div>
                  </div>
                </div>
                <div className="settings-section">
                  <strong>Organization access</strong>
                  {myOrganizations.length > 0 ? (
                    <div className="card-list">
                      {myOrganizations.map((org) => {
                        const existing = projectOrgAccess.find((item) => item.organization_id === org.organization_id);
                        return (
                          <div className="card" key={org.organization_id}>
                            <strong>{org.organization_name}</strong>
                            <select
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
                              <option value="">No access</option>
                              <option value="read">Read only</option>
                              <option value="write">Read + write</option>
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <small>No organization memberships available for this account.</small>
                  )}
                </div>
                <div className="settings-section">
                  <strong>Project access users</strong>
                  {projectAccessUsers.length > 0 ? (
                    <div className="card-list">
                      {projectAccessUsers.map((user) => (
                        <div className="card" key={user.user_id}>
                          <strong>{user.display_name || user.email}</strong>
                          <span>{user.email}</span>
                          <span>{`Access type: ${formatAccessType(user.access_type, user.role)}`}</span>
                          <span>{`Role: ${formatRoleLabel(user.role)}`}</span>
                          <span>{`Source: ${user.sources.map((source) => formatAccessSource(source)).join(", ")}`}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <small>No users currently have access.</small>
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
            <button className="mini" onClick={() => addPath("file", contextMenu.path)}>
              {t("workspace.newFile")}
            </button>
          )}
          {contextMenu.kind === "directory" && (
            <button className="mini" onClick={() => addPath("directory", contextMenu.path)}>
              {t("workspace.newFolder")}
            </button>
          )}
          {contextMenu.kind === "directory" && (
            <button className="mini" onClick={() => uploadFromPicker(contextMenu.path)}>
              {t("workspace.upload")}
            </button>
          )}
          <button className="mini" onClick={() => renamePath(contextMenu.path)}>
            Rename
          </button>
          <button className="mini" onClick={() => removePath(contextMenu.path)}>
            Delete
          </button>
        </div>
      )}
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
        <div className="file-preview-name">{path}</div>
        <a className="button button-small" href={dataUrl} download={downloadName}>
          {t("workspace.download")}
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

function AdminPage({ t }: { t: (key: string) => string }) {
  const defaultOrgId = "00000000-0000-0000-0000-000000000001";
  const roleOptions: Array<{ value: ProjectRole; label: string }> = [
    { value: "Owner", label: "Owner" },
    { value: "Teacher", label: "Manager" },
    { value: "TA", label: "Maintainer" },
    { value: "Student", label: "Contributor" },
    { value: "Viewer", label: "Viewer" }
  ];
  const [orgId, setOrgId] = useState(defaultOrgId);
  const [mappings, setMappings] = useState<OrgGroupRoleMapping[]>([]);
  const [groupName, setGroupName] = useState("");
  const [role, setRole] = useState<ProjectRole>("Student");
  const [settings, setSettings] = useState<AdminAuthSettings | null>(null);
  const [discoveryUrl, setDiscoveryUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [groupMappings, authSettings] = await Promise.all([
        listOrgGroupRoleMappings(orgId),
        getAdminAuthSettings()
      ]);
      setMappings(groupMappings);
      setSettings(authSettings);
      setDiscoveryUrl(authSettings.oidc_issuer || "");
      setError(null);
    } catch (err) {
      setMappings([]);
      setSettings(null);
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load admin settings. Organization admin permission required."
      );
    }
  }

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [orgId]);

  return (
    <section className="page">
      <h2>{t("admin.title")}</h2>
      <div className="card-list">
        <div className="card">
          <strong>{t("admin.authSettings")}</strong>
          {settings ? (
            <>
              <input
                value={settings.site_name || ""}
                onChange={(e) => setSettings({ ...settings, site_name: e.target.value })}
                placeholder={t("admin.siteName")}
              />
              <label>
                <input
                  type="checkbox"
                  checked={settings.allow_local_login}
                  onChange={(e) => setSettings({ ...settings, allow_local_login: e.target.checked })}
                />
                Allow local login
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.allow_local_registration}
                  onChange={(e) =>
                    setSettings({ ...settings, allow_local_registration: e.target.checked })
                  }
                />
                Allow self registration
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.allow_oidc}
                  onChange={(e) => setSettings({ ...settings, allow_oidc: e.target.checked })}
                />
                Allow OIDC
              </label>
              <input
                value={discoveryUrl}
                onChange={(e) => setDiscoveryUrl(e.target.value)}
                placeholder="OIDC discovery URL or issuer URL"
              />
              <input
                value={settings.oidc_client_id || ""}
                onChange={(e) => setSettings({ ...settings, oidc_client_id: e.target.value })}
                placeholder="OIDC client id"
              />
              <input
                value={settings.oidc_client_secret || ""}
                onChange={(e) => setSettings({ ...settings, oidc_client_secret: e.target.value })}
                placeholder="OIDC client secret"
              />
              <input
                value={settings.oidc_redirect_uri || ""}
                onChange={(e) => setSettings({ ...settings, oidc_redirect_uri: e.target.value })}
                placeholder="OIDC redirect URI"
              />
              <input
                value={settings.oidc_groups_claim || "groups"}
                onChange={(e) => setSettings({ ...settings, oidc_groups_claim: e.target.value })}
                placeholder="OIDC groups claim"
              />
              <button
                className="button"
                onClick={async () => {
                  if (!settings) return;
                  const updated = await upsertAdminAuthSettings({
                    allow_local_login: settings.allow_local_login,
                    allow_local_registration: settings.allow_local_registration,
                    allow_oidc: settings.allow_oidc,
                    site_name: settings.site_name || null,
                    oidc_discovery_url: discoveryUrl || null,
                    oidc_client_id: settings.oidc_client_id || null,
                    oidc_client_secret: settings.oidc_client_secret || null,
                    oidc_redirect_uri: settings.oidc_redirect_uri || null,
                    oidc_groups_claim: settings.oidc_groups_claim || "groups"
                  });
                  setSettings(updated);
                }}
              >
                Save Auth Settings
              </button>
            </>
          ) : (
            <span>Loading...</span>
          )}
        </div>

        <div className="card">
          <strong>OIDC Group to Project Role Mapping</strong>
          <div className="toolbar">
            <input value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="Organization ID" />
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="OIDC group"
            />
            <select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
              {roleOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              className="button"
              onClick={async () => {
                if (!groupName.trim()) return;
                await upsertOrgGroupRoleMapping(orgId, { group_name: groupName.trim(), role });
                setGroupName("");
                await refresh();
              }}
            >
              Save
            </button>
          </div>
          <div className="card-list">
            {mappings.map((mapping) => (
              <div className="card" key={mapping.group_name}>
                <strong>{mapping.group_name}</strong>
                <span>{roleOptions.find((option) => option.value === mapping.role)?.label ?? mapping.role}</span>
                <button
                  className="button"
                  onClick={async () => {
                    await deleteOrgGroupRoleMapping(orgId, mapping.group_name);
                    await refresh();
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}

function ProfilePage({ t }: { t: (key: string) => string }) {
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
      setError(err instanceof Error ? err.message : "Unable to load tokens");
    }
  }

  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);

  function formatOptionalDate(value: string | null) {
    if (!value) return "never";
    return new Date(value).toLocaleString();
  }

  function computeExpiresAt(): string | null {
    if (tokenExpiryPreset === "never") return null;
    if (tokenExpiryPreset === "custom") {
      if (!tokenCustomExpiresAtLocal.trim()) return null;
      const parsed = new Date(tokenCustomExpiresAtLocal);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error("Invalid custom expiry time");
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
      const message = err instanceof Error ? err.message : "Unable to create token";
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
          <strong>Personal Access Tokens</strong>
          <span className="muted">
            Use token as Git HTTP password. Each token is shown once on creation.
          </span>
          <div className="profile-token-form">
            <label>
              <span>Token label</span>
              <input
                value={tokenLabel}
                onChange={(e) => setTokenLabel(e.target.value)}
                placeholder="e.g. Laptop Git, CI runner"
              />
            </label>
            <label>
              <span>Expires</span>
              <select
                value={tokenExpiryPreset}
                onChange={(e) =>
                  setTokenExpiryPreset(e.target.value as "never" | "7d" | "30d" | "90d" | "custom")
                }
              >
                <option value="never">Never</option>
                <option value="7d">7 days</option>
                <option value="30d">30 days</option>
                <option value="90d">90 days</option>
                <option value="custom">Custom date/time</option>
              </select>
            </label>
            {tokenExpiryPreset === "custom" && (
              <label>
                <span>Custom expiry</span>
                <input
                  type="datetime-local"
                  value={tokenCustomExpiresAtLocal}
                  onChange={(e) => setTokenCustomExpiresAtLocal(e.target.value)}
                />
              </label>
            )}
          </div>
          <div className="toolbar">
            <button className="button filled" onClick={createToken} disabled={creating || !tokenLabel.trim()}>
              {creating ? "Creating..." : "Create Token"}
            </button>
          </div>
        </div>
        {newToken && (
          <div className="card profile-new-token">
            <strong>New token (shown once)</strong>
            <div className="token-reveal">{newToken.token}</div>
            <div className="toolbar">
              <button
                className="button button-small"
                onClick={async () => {
                  await navigator.clipboard.writeText(newToken.token);
                  setCopiedToken(true);
                  window.setTimeout(() => setCopiedToken(false), 1200);
                }}
              >
                {copiedToken ? "Copied" : "Copy token"}
              </button>
            </div>
            <small className="muted">
              Label: {newToken.label} · Prefix: {newToken.token_prefix} · Expires:{" "}
              {formatOptionalDate(newToken.expires_at || null)}
            </small>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="card">
          <strong>Token list</strong>
          <div className="card-list">
            {tokens.map((token) => (
              <div className="card" key={token.id}>
                <strong>{token.label}</strong>
                <span>Prefix: {token.token_prefix}</span>
                <span>Created: {new Date(token.created_at).toLocaleString()}</span>
                <span>Expires: {formatOptionalDate(token.expires_at)}</span>
                <span>Last used: {formatOptionalDate(token.last_used_at)}</span>
                <span>Status: {token.revoked_at ? `Revoked at ${formatOptionalDate(token.revoked_at)}` : "Active"}</span>
                <div className="toolbar">
                  <button
                    className="button button-small"
                    onClick={async () => {
                      await navigator.clipboard.writeText(token.token_prefix);
                    }}
                  >
                    Copy prefix
                  </button>
                  <button
                    className="button button-small"
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
                    {token.revoked_at ? "Revoked" : "Revoke"}
                  </button>
                </div>
              </div>
            ))}
            {tokens.length === 0 && <div className="card muted">No tokens yet.</div>}
          </div>
        </div>
      </div>
    </section>
  );
}
