import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import * as Y from "yjs";
import { EditorPane } from "@/components/EditorPane";
import { HistoryPanel } from "@/components/HistoryPanel";
import { PresenceBar } from "@/components/PresenceBar";
import { bindRealtimeYDoc, type PresencePeer } from "@/lib/realtime";
import { resolveDevUserId } from "@/lib/dev-auth";
import { compileTypstClientSide, renderTypstVectorToCanvas } from "@/lib/typst";
import {
  createPersonalAccessToken,
  createProject,
  createProjectFile,
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
  listOrgGroupRoleMappings,
  listPersonalAccessTokens,
  listProjectAssets,
  listProjects,
  listRevisions,
  localLogin,
  localRegister,
  logout,
  oidcLoginUrl,
  projectArchiveUrl,
  revokePersonalAccessToken,
  type AdminAuthSettings,
  type AuthConfig,
  type AuthUser,
  type OrgGroupRoleMapping,
  type PersonalAccessTokenInfo,
  type Project,
  type ProjectRole,
  type Revision,
  moveProjectFile,
  upsertAdminAuthSettings,
  upsertDocumentByPath,
  upsertOrgGroupRoleMapping,
  upsertProjectSettings,
  uploadProjectAsset
} from "@/lib/api";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

type ProjectTreeNodeView = {
  name: string;
  path: string;
  kind: "file" | "directory";
  children: ProjectTreeNodeView[];
};

function normalizePath(path: string) {
  return path.trim().replace(/^\/+/, "");
}

function isTextFile(path: string) {
  return /\.(typ|txt|md|json|toml|yaml|yml|csv|xml|html|css|js|ts|tsx|jsx)$/i.test(path);
}

function isFontFile(path: string) {
  return /\.(ttf|otf|woff|woff2)$/i.test(path);
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
  const [authLoading, setAuthLoading] = useState(true);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();

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
      return;
    }
    listProjects()
      .then((res) => {
        setProjects(res.projects);
        setError(null);
      })
      .catch(() => {
        setProjects([]);
        setError("Unable to load projects");
      });
  }, [authUser?.user_id]);

  const firstProject = projects[0]?.id;

  async function handleLogout() {
    await logout();
    setAuthUser(null);
    setProjects([]);
  }

  async function refreshProjects() {
    if (!authUser) return;
    const next = await listProjects();
    setProjects(next.projects);
  }

  if (authLoading) return <main className="loading">Loading...</main>;

  if (!authUser && !resolveDevUserId()) {
    return (
      <SignInPage
        config={authConfig}
        onSignedIn={async () => {
          const me = await getAuthMe();
          setAuthUser(me);
          await refreshProjects();
        }}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <strong>Typst Collaboration</strong>
        <nav className="tabs">
          <Link className={location.pathname === "/projects" ? "tab active" : "tab"} to="/projects">
            Projects
          </Link>
          <Link className={location.pathname.startsWith("/admin") ? "tab active" : "tab"} to="/admin">
            Admin
          </Link>
          <Link className={location.pathname.startsWith("/profile") ? "tab active" : "tab"} to="/profile">
            Profile
          </Link>
          {firstProject && (
            <Link
              className={location.pathname.startsWith("/project/") ? "tab active" : "tab"}
              to={`/project/${firstProject}`}
            >
              Workspace
            </Link>
          )}
        </nav>
        <div className="meta">
          <span>{authUser?.display_name || "User"}</span>
          <button className="button" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>
      {error && <div className="error-banner">{error}</div>}
      <Routes>
        <Route path="/" element={<Navigate to={firstProject ? `/project/${firstProject}` : "/projects"} replace />} />
        <Route
          path="/projects"
          element={<ProjectsPage projects={projects} refreshProjects={refreshProjects} />}
        />
        <Route path="/project/:projectId" element={<WorkspacePage projects={projects} authUser={authUser} />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Routes>
    </main>
  );
}

function SignInPage({
  config,
  onSignedIn
}: {
  config: AuthConfig | null;
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
        <h2>Sign In</h2>
        <p>Use local account credentials or your OpenID Connect provider.</p>
        <div className="toolbar">
          <button className={`button ${mode === "login" ? "filled" : ""}`} onClick={() => setMode("login")}>
            Local Login
          </button>
          {config?.allow_local_registration && (
            <button className={`button ${mode === "register" ? "filled" : ""}`} onClick={() => setMode("register")}>
              Register
            </button>
          )}
          {config?.allow_oidc && (
            <a className="button" href={oidcLoginUrl()}>
              OIDC Login
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
            Continue
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}

function ProjectsPage({
  projects,
  refreshProjects
}: {
  projects: Project[];
  refreshProjects: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="page">
      <h2>Projects</h2>
      <div className="card create-card">
        <strong>Create Project</strong>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
        />
        <button
          className="button"
          onClick={async () => {
            if (!name.trim()) return;
            try {
              setError(null);
              await createProject({
                organization_id: DEFAULT_ORG_ID,
                name: name.trim(),
                description: description.trim() || null
              });
              setName("");
              setDescription("");
              await refreshProjects();
            } catch (err) {
              const message = err instanceof Error ? err.message : "Unable to create project";
              setError(message);
            }
          }}
        >
          Create
        </button>
        {error && <div className="error">{error}</div>}
      </div>
      <div className="card-list">
        {projects.map((project) => (
          <Link key={project.id} to={`/project/${project.id}`} className="card">
            <strong>{project.name}</strong>
            <span>{project.description || "No description"}</span>
          </Link>
        ))}
        {projects.length === 0 && <div className="card">No projects are available for this account.</div>}
      </div>
    </section>
  );
}

function WorkspacePage({ projects, authUser }: { projects: Project[]; authUser: AuthUser | null }) {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const devUserId = resolveDevUserId();
  const effectiveUserId = (authUser?.user_id ?? devUserId) || "local-user";
  const effectiveUserName = authUser?.display_name || "Developer";
  const ydocRef = useRef<Y.Doc | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const realtimeRef = useRef<{ close: () => void; sendCursor: (cursor: { line: number; column: number }) => void } | null>(null);
  const canvasPreviewRef = useRef<HTMLDivElement | null>(null);
  const lastSavedDocRef = useRef<string>("");

  const [nodes, setNodes] = useState<{ path: string; kind: "file" | "directory" }[]>([]);
  const [entryFilePath, setEntryFilePath] = useState("main.typ");
  const [activePath, setActivePath] = useState("main.typ");
  const [docs, setDocs] = useState<Record<string, string>>({});
  const [assetBase64, setAssetBase64] = useState<Record<string, string>>({});
  const [docText, setDocText] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [presence, setPresence] = useState<PresencePeer[]>([]);
  const [vectorData, setVectorData] = useState<Uint8Array | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [compiledAt, setCompiledAt] = useState<number | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [activeRevisionId, setActiveRevisionId] = useState<string | null>(null);
  const [revisionDocs, setRevisionDocs] = useState<Record<string, string>>({});
  const [showRevisionPanel, setShowRevisionPanel] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set([""]));
  const [contextPath, setContextPath] = useState<string | null>(null);
  const [bundledFonts, setBundledFonts] = useState<Uint8Array[]>([]);

  const tree = useMemo(() => projectTreeFromFlat(nodes), [nodes]);
  const isRevisionMode = !!activeRevisionId;
  const sourceDocs = isRevisionMode ? revisionDocs : docs;
  const compileDocuments = useMemo(
    () => Object.entries(sourceDocs).map(([path, content]) => ({ path, content })),
    [sourceDocs]
  );
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

  const project = projects.find((p) => p.id === projectId);

  const refreshProjectData = async () => {
    if (!projectId) return;
    setWorkspaceLoaded(false);
    const [treeRes, settings, git, docsRes, revisionsRes, assetsRes] = await Promise.all([
      getProjectTree(projectId),
      getProjectSettings(projectId).catch(() => ({ entry_file_path: "main.typ" })),
      getGitRepoLink(projectId).catch(() => ({ repo_url: "" })),
      listDocuments(projectId),
      listRevisions(projectId).catch(() => ({ revisions: [] })),
      listProjectAssets(projectId).catch(() => ({ assets: [] }))
    ]);
    setNodes(treeRes.nodes);
    setEntryFilePath(settings.entry_file_path || treeRes.entry_file_path || "main.typ");
    setGitRepoUrl(git.repo_url || "");
    setRevisions(revisionsRes.revisions || []);

    const nextDocs: Record<string, string> = {};
    for (const doc of docsRes.documents) nextDocs[doc.path] = doc.content;
    setDocs(nextDocs);

    const nextAssets: Record<string, string> = {};
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
    setAssetBase64(nextAssets);

    if (!activePath || !treeRes.nodes.some((node) => node.path === activePath)) {
      const firstFile = treeRes.nodes.find((n) => n.kind === "file")?.path || settings.entry_file_path;
      setActivePath(firstFile || "main.typ");
    }
    setWorkspaceLoaded(true);
  };

  useEffect(() => {
    setWorkspaceLoaded(false);
    setWorkspaceError(null);
    setCompileErrors([]);
    setVectorData(null);
    setPdfData(null);
    setCompiledAt(null);
    setPresence([]);
    setDocText("");
    refreshProjectData().catch((err) => {
      const message = err instanceof Error ? err.message : "Unable to load workspace";
      setWorkspaceError(message);
      setWorkspaceLoaded(true);
    });
  }, [projectId]);

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
    if (isRevisionMode) {
      const content = revisionDocs[activePath] ?? "";
      setDocText(content);
      return;
    }
    if (!projectId || !activePath) {
      setDocText("");
      return;
    }
    const existing = docs[activePath];
    if (typeof existing === "string") setDocText(existing);
    else setDocText("");
  }, [activePath, docs, isRevisionMode, projectId, revisionDocs]);

  useEffect(() => {
    if (!projectId || !activePath || isRevisionMode || !workspaceLoaded) return;
    if (!(activePath in docs)) {
      setPresence([]);
      setDocText("");
      return;
    }
    const fileContent = docs[activePath] ?? "";
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("main");
    ydocRef.current = ydoc;
    ytextRef.current = ytext;
    const baselineDoc = new Y.Doc();
    // Build a deterministic baseline update so peers do not duplicate initial text on first sync.
    baselineDoc.clientID = 1;
    baselineDoc.getText("main").insert(0, fileContent);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(baselineDoc), "bootstrap");
    baselineDoc.destroy();
    lastSavedDocRef.current = fileContent;
    setDocText(fileContent);

    const observer = (event: Y.YTextEvent) => {
      const next = event.target.toString();
      setDocText(next);
      setDocs((prev) => ({ ...prev, [activePath]: next }));
    };
    ytext.observe(observer);
    const realtime = bindRealtimeYDoc({
      docId: `${projectId}:${activePath}`,
      projectId,
      wsBaseUrl: `${window.location.origin.replace(/^http/, "ws")}`,
      ydoc,
      userId: effectiveUserId,
      userName: effectiveUserName,
      onPresenceChange: setPresence
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
    };
  }, [activePath, docs, effectiveUserId, effectiveUserName, isRevisionMode, projectId, workspaceLoaded]);

  useEffect(() => {
    if (!projectId || !activePath || isRevisionMode || !workspaceLoaded) return;
    if (!(activePath in docs)) return;
    if (docText === lastSavedDocRef.current) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      upsertDocumentByPath(projectId, activePath, docText)
        .then((saved) => {
          lastSavedDocRef.current = saved.content;
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [activePath, docText, isRevisionMode, projectId, workspaceLoaded]);

  useEffect(() => {
    if (!projectId || !workspaceLoaded) return;
    let cancelled = false;
    if (compileDocuments.length === 0) {
      setVectorData(null);
      setPdfData(null);
      setCompileErrors(["Project has no source documents"]);
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
        setCompiledAt(output.compiledAt);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [compileAssets, compileDocuments, entryFilePath, fontData, projectId, workspaceLoaded]);

  useEffect(() => {
    const el = canvasPreviewRef.current;
    if (!el) return;
    if (!vectorData) {
      el.replaceChildren();
      return;
    }
    renderTypstVectorToCanvas(el, vectorData).catch((err) => {
      const message = err instanceof Error ? err.message : "Preview render failed";
      setCompileErrors([message]);
      el.replaceChildren();
    });
  }, [vectorData]);

  useEffect(() => {
    if (!projectId || isRevisionMode || !workspaceLoaded) return;
    const timer = window.setInterval(() => {
      listDocuments(projectId)
        .then((res) => {
          setDocs((prev) => {
            const next: Record<string, string> = { ...prev };
            const incoming = new Set<string>();
            for (const doc of res.documents) {
              incoming.add(doc.path);
              if (doc.path === activePath && docText !== lastSavedDocRef.current) {
                continue;
              }
              next[doc.path] = doc.content;
            }
            for (const path of Object.keys(next)) {
              if (path === activePath) continue;
              if (!incoming.has(path)) delete next[path];
            }
            return next;
          });
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activePath, docText, isRevisionMode, projectId, workspaceLoaded]);

  useEffect(() => {
    if (!contextPath) return;
    const closeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".context-menu")) return;
      if (target.closest(".mini")) return;
      setContextPath(null);
    };
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, [contextPath]);

  function updateDocumentViaYjs(nextValue: string) {
    if (isRevisionMode) return;
    const ydoc = ydocRef.current;
    const ytext = ytextRef.current;
    if (!ydoc || !ytext) {
      setDocText(nextValue);
      return;
    }
    const current = ytext.toString();
    if (nextValue === current) return;
    let prefix = 0;
    const minLength = Math.min(current.length, nextValue.length);
    while (prefix < minLength && current.charCodeAt(prefix) === nextValue.charCodeAt(prefix)) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < current.length - prefix &&
      suffix < nextValue.length - prefix &&
      current.charCodeAt(current.length - 1 - suffix) === nextValue.charCodeAt(nextValue.length - 1 - suffix)
    ) {
      suffix += 1;
    }
    const deleteCount = current.length - prefix - suffix;
    const insertText = nextValue.slice(prefix, nextValue.length - suffix);
    ydoc.transact(() => {
      if (deleteCount > 0) ytext.delete(prefix, deleteCount);
      if (insertText) ytext.insert(prefix, insertText);
    });
  }

  async function addPath(kind: "file" | "directory") {
    if (!projectId) return;
    const raw = window.prompt(kind === "file" ? "New file path" : "New directory path");
    if (!raw) return;
    await createProjectFile(projectId, {
      path: normalizePath(raw),
      kind,
      content: kind === "file" ? "" : undefined
    });
    await refreshProjectData();
    if (kind === "file") setActivePath(normalizePath(raw));
  }

  async function renamePath(path: string) {
    if (!projectId) return;
    const to = window.prompt("Rename to", path);
    if (!to || normalizePath(to) === path) return;
    await moveProjectFile(projectId, path, normalizePath(to));
    setContextPath(null);
    await refreshProjectData();
    if (activePath === path) setActivePath(normalizePath(to));
  }

  async function removePath(path: string) {
    if (!projectId) return;
    if (!window.confirm(`Delete ${path}?`)) return;
    await deleteProjectFile(projectId, path);
    setContextPath(null);
    if (activePath === path) setActivePath(entryFilePath);
    await refreshProjectData();
  }

  async function uploadFiles() {
    if (!projectId) return;
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.onchange = async () => {
      const files = Array.from(picker.files || []);
      for (const file of files) {
        const defaultPath = file.name;
        const target = window.prompt(`Target path for ${file.name}`, defaultPath);
        if (!target) continue;
        const path = normalizePath(target);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (isTextFile(path) || file.type.startsWith("text/")) {
          const text = new TextDecoder().decode(bytes);
          await createProjectFile(projectId, { path, kind: "file", content: text });
          setDocs((prev) => ({ ...prev, [path]: text }));
        } else {
          const binary = Array.from(bytes, (value) => String.fromCharCode(value)).join("");
          await uploadProjectAsset(projectId, {
            path,
            content_base64: btoa(binary),
            content_type: file.type || "application/octet-stream"
          });
        }
      }
      await refreshProjectData();
    };
    picker.click();
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
    const first = Object.keys(map)[0];
    if (first) setActivePath(first);
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

  if (!projectId) return <Navigate to="/projects" replace />;
  if (!project && projects.length > 0) {
    return <Navigate to={`/project/${projects[0].id}`} replace />;
  }

  return (
    <section className="workspace-grid">
      <aside className="panel left">
        <h2>Projects & Files</h2>
        <div className="panel-content">
          <div className="project-list">
            {projects.map((p) => (
              <button
                key={p.id}
                className={`project-pill ${p.id === projectId ? "active" : ""}`}
                onClick={() => navigate(`/project/${p.id}`)}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="toolbar">
            <button className="button" onClick={() => addPath("file")}>
              New File
            </button>
            <button className="button" onClick={() => addPath("directory")}>
              New Folder
            </button>
            <button className="button" onClick={uploadFiles}>
              Upload Files
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
                contextPath={contextPath}
                setContextPath={setContextPath}
                onOpen={(path) => setActivePath(path)}
                onRename={renamePath}
                onDelete={removePath}
              />
            ))}
          </div>
        </div>
      </aside>

      <article className="panel middle">
        <h2>Editor</h2>
        <div className="panel-content">
          <div className="meta">
            <span>Project: {project?.name ?? projectId}</span>
            <span>File: {activePath}</span>
            <span>Mode: {isRevisionMode ? "Revision (read-only)" : "Live"}</span>
            <span>Save: {saveState}</span>
            <span>Workspace: {workspaceLoaded ? "ready" : "loading"}</span>
            <span>Compiled: {compiledAt ? new Date(compiledAt).toLocaleTimeString() : "n/a"}</span>
          </div>
          <PresenceBar
            users={presence
              .filter((peer) => peer.id !== effectiveUserId)
              .map((peer, index) => ({
                id: peer.id,
                name: peer.name,
                color: ["#1f5f8c", "#156f43", "#7e3b9f", "#8e5a17"][index % 4],
                line: peer.line,
                column: peer.column
              }))}
          />
          <EditorPane
            value={docText}
            onChange={updateDocumentViaYjs}
            onCursorChange={(cursor) => realtimeRef.current?.sendCursor(cursor)}
            readOnly={isRevisionMode || !(activePath in docs)}
          />
          {!(activePath in docs) && (
            <div className="error">
              This is a binary/non-editable file in the web editor. Edit it offline and sync via Git if needed.
            </div>
          )}
          {compileErrors.length > 0 && <div className="error">{compileErrors.join("; ")}</div>}
          {workspaceError && <div className="error">{workspaceError}</div>}
        </div>
      </article>

      <aside className="panel right">
        <h2>Preview & Revisions</h2>
        <div className="panel-content">
          <div ref={canvasPreviewRef} className="pdf-frame" />
          <div className="toolbar">
            <button className="button" onClick={downloadCompiledPdf} disabled={!pdfData}>
              Download PDF (Client)
            </button>
            <a className="button" href={projectArchiveUrl(projectId)} target="_blank" rel="noreferrer">
              Download Archive
            </a>
          </div>

          <button className="button" onClick={() => setShowProjectSettings((v) => !v)}>
            {showProjectSettings ? "Hide Project Settings" : "Show Project Settings"}
          </button>
          {showProjectSettings && (
            <div className="git-box">
              <strong>Project Settings</strong>
              <label>
                Entry file
                <select
                  value={entryFilePath}
                  onChange={async (e) => {
                    const next = e.target.value;
                    const updated = await upsertProjectSettings(projectId, next);
                    setEntryFilePath(updated.entry_file_path);
                  }}
                >
                  {Object.keys(docs)
                    .filter((path) => path.endsWith(".typ"))
                    .map((path) => (
                      <option value={path} key={path}>
                        {path}
                      </option>
                    ))}
                </select>
              </label>
              <div>
                <strong>Git Access URL</strong>
                <code>{gitRepoUrl || "Loading..."}</code>
                <small>Use Personal Access Token as HTTP password. Force push is rejected.</small>
              </div>
            </div>
          )}

          <button className="button" onClick={() => setShowRevisionPanel((v) => !v)}>
            {showRevisionPanel ? "Hide Revisions" : "Show Revisions"}
          </button>
          {showRevisionPanel && (
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
          )}
        </div>
      </aside>
    </section>
  );
}

function TreeNodeRow({
  node,
  activePath,
  expanded,
  setExpanded,
  contextPath,
  setContextPath,
  onOpen,
  onRename,
  onDelete
}: {
  node: ProjectTreeNodeView;
  activePath: string;
  expanded: Set<string>;
  setExpanded: (next: Set<string>) => void;
  contextPath: string | null;
  setContextPath: (path: string | null) => void;
  onOpen: (path: string) => void;
  onRename: (path: string) => Promise<void>;
  onDelete: (path: string) => Promise<void>;
}) {
  const isExpanded = expanded.has(node.path);
  const isActive = activePath === node.path;
  return (
    <div className="tree-branch">
      <div className={`tree-node ${isActive ? "active" : ""}`}>
        {node.kind === "directory" ? (
          <button
            className="tree-toggle"
            onClick={() => {
              const next = new Set(expanded);
              if (isExpanded) next.delete(node.path);
              else next.add(node.path);
              setExpanded(next);
            }}
          >
            {isExpanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-toggle tree-placeholder" />
        )}
        <button className="tree-label" onClick={() => (node.kind === "file" ? onOpen(node.path) : undefined)}>
          <span className={`tree-kind ${node.kind}`}>{node.kind === "directory" ? "Dir" : "File"}</span>
          <span className="tree-name">{node.name}</span>
        </button>
        <button className="mini" onClick={() => setContextPath(contextPath === node.path ? null : node.path)}>
          ⋮
        </button>
        {contextPath === node.path && (
          <div className="context-menu">
            <button className="mini" onClick={() => onRename(node.path)}>
              Rename
            </button>
            <button className="mini" onClick={() => onDelete(node.path)}>
              Delete
            </button>
          </div>
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
              contextPath={contextPath}
              setContextPath={setContextPath}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AdminPage() {
  const roleOptions: Array<{ value: ProjectRole; label: string }> = [
    { value: "Owner", label: "Owner" },
    { value: "Teacher", label: "Manager" },
    { value: "TA", label: "Maintainer" },
    { value: "Student", label: "Contributor" }
  ];
  const [orgId, setOrgId] = useState(DEFAULT_ORG_ID);
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
    } catch {
      setMappings([]);
      setSettings(null);
      setError("Unable to load admin settings. Organization admin permission required.");
    }
  }

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [orgId]);

  return (
    <section className="page">
      <h2>Admin Panel</h2>
      <div className="card-list">
        <div className="card">
          <strong>Authentication Settings</strong>
          {settings ? (
            <>
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

function ProfilePage() {
  const [tokens, setTokens] = useState<PersonalAccessTokenInfo[]>([]);
  const [tokenLabel, setTokenLabel] = useState("CLI token");
  const [tokenExpiresAt, setTokenExpiresAt] = useState("");
  const [newToken, setNewToken] = useState<CreatePatResponseLike | null>(null);
  const [error, setError] = useState<string | null>(null);

  type CreatePatResponseLike = {
    token: string;
    token_prefix: string;
    label: string;
  };

  async function refresh() {
    try {
      const res = await listPersonalAccessTokens();
      setTokens(res.tokens);
      setError(null);
    } catch {
      setTokens([]);
      setError("Unable to load tokens");
    }
  }

  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);

  async function createToken() {
    if (!tokenLabel.trim()) return;
    const created = await createPersonalAccessToken({
      label: tokenLabel.trim(),
      expires_at: tokenExpiresAt.trim() || null
    });
    setNewToken({
      token: created.token,
      token_prefix: created.token_prefix,
      label: created.label
    });
    await refresh();
  }

  return (
    <section className="page">
      <h2>Profile Security</h2>
      <div className="panel-content">
        <div className="toolbar">
          <input value={tokenLabel} onChange={(e) => setTokenLabel(e.target.value)} placeholder="Token label" />
          <input
            value={tokenExpiresAt}
            onChange={(e) => setTokenExpiresAt(e.target.value)}
            placeholder="Expires at (optional RFC3339)"
          />
          <button className="button" onClick={createToken}>
            Create Token
          </button>
        </div>
        {newToken && (
          <div className="error">
            New token shown once: <code>{newToken.token}</code>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="card-list">
          {tokens.map((token) => (
            <div className="card" key={token.id}>
              <strong>{token.label}</strong>
              <span>{token.token_prefix}</span>
              <span>Last used: {token.last_used_at ? new Date(token.last_used_at).toLocaleString() : "never"}</span>
              <button
                className="button"
                onClick={async () => {
                  await revokePersonalAccessToken(token.id);
                  await refresh();
                }}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
