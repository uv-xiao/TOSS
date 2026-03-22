import { useEffect, useMemo, useRef, useState, startTransition } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import * as Y from "yjs";
import { EditorPane } from "@/components/EditorPane";
import { PresenceBar } from "@/components/PresenceBar";
import { HistoryPanel } from "@/components/HistoryPanel";
import { bindRealtimeYDoc } from "@/lib/realtime";
import { resolveDevUserId } from "@/lib/dev-auth";
import { compileTypstClientSide, renderTypstVectorToCanvas } from "@/lib/typst";
import {
  createPersonalAccessToken,
  createProjectFile,
  createRevision,
  deleteOrgGroupRoleMapping,
  deleteProjectFile,
  getAuthMe,
  getGitRepoLink,
  getProjectAssetContent,
  getProjectSettings,
  getProjectTree,
  latestProjectPdfUrl,
  listDocuments,
  listOrgGroupRoleMappings,
  listPersonalAccessTokens,
  listProjectAssets,
  listProjects,
  listRevisions,
  logout,
  oidcLoginUrl,
  projectArchiveUrl,
  revokePersonalAccessToken,
  type OrgGroupRoleMapping,
  type PersonalAccessTokenInfo,
  type Project,
  type ProjectRole,
  type Revision,
  moveProjectFile,
  upsertDocumentByPath,
  uploadProjectPdfArtifact,
  upsertOrgGroupRoleMapping,
  upsertProjectSettings,
  uploadProjectAsset
} from "@/lib/api";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

type AuthUser = {
  user_id: string;
  email: string;
  display_name: string;
  session_expires_at: string;
};

export function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();

  useEffect(() => {
    getAuthMe()
      .then((me) => setAuthUser(me))
      .catch(() => setAuthUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (authLoading) return;
    listProjects()
      .then((res) => {
        setProjects(res.projects);
        setError(null);
      })
      .catch(() => {
        setProjects([]);
        if (authUser) {
          setError("Unable to load projects");
        }
      });
  }, [authLoading, authUser?.user_id]);

  const firstProject = projects[0]?.id;

  async function handleLogout() {
    await logout();
    setAuthUser(null);
    setProjects([]);
  }

  if (authLoading) {
    return <main className="loading">Loading...</main>;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <strong>Typst School Collaboration</strong>
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
          {authUser ? (
            <>
              <span>{authUser.display_name}</span>
              <button className="button" onClick={handleLogout}>
                Logout
              </button>
            </>
          ) : (
            <a className="button" href={oidcLoginUrl()}>
              Sign in with OIDC
            </a>
          )}
        </div>
      </header>
      {error && <div className="error-banner">{error}</div>}
      <Routes>
        <Route path="/" element={<Navigate to={firstProject ? `/project/${firstProject}` : "/projects"} replace />} />
        <Route path="/projects" element={<ProjectsPage projects={projects} />} />
        <Route path="/project/:projectId" element={<WorkspacePage projects={projects} authUser={authUser} />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Routes>
    </main>
  );
}

function ProjectsPage({ projects }: { projects: Project[] }) {
  return (
    <section className="page">
      <h2>Projects</h2>
      <div className="card-list">
        {projects.map((project) => (
          <Link key={project.id} to={`/project/${project.id}`} className="card">
            <strong>{project.name}</strong>
            <span>{project.description || "No description"}</span>
          </Link>
        ))}
        {projects.length === 0 && <div className="card">No projects available for this account.</div>}
      </div>
    </section>
  );
}

function WorkspacePage({ projects, authUser }: { projects: Project[]; authUser: AuthUser | null }) {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const localUserId = "local-user";
  const devUserId = resolveDevUserId();
  const effectiveUserId = (authUser?.user_id ?? devUserId) || localUserId;
  const ydocRef = useRef<Y.Doc | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const canvasPreviewRef = useRef<HTMLDivElement | null>(null);
  const lastSavedDocRef = useRef<string>("");
  const [treeNodes, setTreeNodes] = useState<{ path: string; kind: "file" | "directory" }[]>([]);
  const [entryFilePath, setEntryFilePath] = useState("main.typ");
  const [activePath, setActivePath] = useState("main.typ");
  const [docText, setDocText] = useState("");
  const [documentCache, setDocumentCache] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [presenceUserIds, setPresenceUserIds] = useState<string[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [newRevision, setNewRevision] = useState("");
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [fontData, setFontData] = useState<Uint8Array[]>([]);
  const [vectorData, setVectorData] = useState<Uint8Array | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [compiledAt, setCompiledAt] = useState<number | null>(null);
  const deferredDocument = useMemo(() => docText, [docText]);

  const compileSource = useMemo(() => {
    return documentCache[entryFilePath] ?? (activePath === entryFilePath ? docText : "");
  }, [activePath, docText, documentCache, entryFilePath]);

  useEffect(() => {
    if (!projectId) return;
    getProjectTree(projectId)
      .then((tree) => {
        setTreeNodes(tree.nodes);
        setEntryFilePath(tree.entry_file_path);
        const firstFile = tree.nodes.find((n) => n.kind === "file")?.path;
        setActivePath(firstFile ?? tree.entry_file_path);
      })
      .catch(() => {
        setTreeNodes([]);
      });

    getProjectSettings(projectId)
      .then((settings) => setEntryFilePath(settings.entry_file_path))
      .catch(() => undefined);

    getGitRepoLink(projectId)
      .then((res) => setGitRepoUrl(res.repo_url))
      .catch(() => setGitRepoUrl(""));

    listRevisions(projectId)
      .then((res) => setRevisions(res.revisions))
      .catch(() => setRevisions([]));

    listProjectAssets(projectId)
      .then(async (res) => {
        const fallbackFonts: Uint8Array[] = [];
        try {
          const bundled = await fetch("/typst-fonts/NotoSans-Regular.ttf");
          if (bundled.ok) fallbackFonts.push(new Uint8Array(await bundled.arrayBuffer()));
        } catch {
          // Ignore fallback failures.
        }
        const fontAssets = res.assets.filter((asset) => /\.(ttf|otf|woff|woff2)$/i.test(asset.path));
        const contents = await Promise.all(
          fontAssets.map((asset) => getProjectAssetContent(projectId, asset.id))
        );
        const buffers = contents.map((item) => {
          const binary = atob(item.content_base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          return bytes;
        });
        setFontData([...fallbackFonts, ...buffers]);
      })
      .catch(() => setFontData([]));
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !activePath) return;
    listDocuments(projectId, activePath)
      .then((res) => {
        const doc = res.documents[0];
        const content = doc?.content ?? "";
        updateDocumentViaYjs(content);
        lastSavedDocRef.current = content;
        setDocumentCache((prev) => ({ ...prev, [activePath]: content }));
      })
      .catch(() => {
        updateDocumentViaYjs("");
      });
  }, [projectId, activePath]);

  useEffect(() => {
    if (!projectId || !activePath) return;
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("main");
    ydocRef.current = ydoc;
    ytextRef.current = ytext;
    ydoc.transact(() => {
      ytext.insert(0, "");
    }, "init");
    const unobserve = (event: Y.YTextEvent) => {
      const next = event.target.toString();
      setDocText(next);
      setDocumentCache((prev) => ({ ...prev, [activePath]: next }));
    };
    ytext.observe(unobserve);
    const realtime = bindRealtimeYDoc({
      docId: `${projectId}:${activePath}`,
      projectId,
      wsBaseUrl: `${window.location.origin.replace(/^http/, "ws")}`,
      ydoc,
      userId: effectiveUserId,
      onPresenceChange: setPresenceUserIds
    });
    return () => {
      ytext.unobserve(unobserve);
      realtime.close();
      ydoc.destroy();
      ydocRef.current = null;
      ytextRef.current = null;
    };
  }, [activePath, effectiveUserId, projectId]);

  useEffect(() => {
    if (!projectId || !activePath) return;
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
  }, [activePath, docText, projectId]);

  useEffect(() => {
    let cancelled = false;
    startTransition(() => {
      compileTypstClientSide(compileSource || "= Empty\n", {
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
  }, [compileSource, fontData]);

  useEffect(() => {
    const el = canvasPreviewRef.current;
    if (!el || !vectorData) return;
    renderTypstVectorToCanvas(el, vectorData).catch(() => undefined);
  }, [vectorData]);

  function updateDocumentViaYjs(nextValue: string) {
    const ydoc = ydocRef.current;
    const ytext = ytextRef.current;
    if (!ydoc || !ytext) {
      setDocText(nextValue);
      return;
    }
    if (nextValue === ytext.toString()) return;
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, nextValue);
    });
  }

  async function addFile(kind: "file" | "directory") {
    if (!projectId) return;
    const raw = window.prompt(kind === "file" ? "File path" : "Directory path");
    if (!raw) return;
    try {
      setWorkspaceError(null);
      await createProjectFile(projectId, {
        path: raw.trim(),
        kind,
        content: kind === "file" ? "" : undefined
      });
      const tree = await getProjectTree(projectId);
      setTreeNodes(tree.nodes);
      if (kind === "file") setActivePath(raw.trim());
    } catch {
      setWorkspaceError("Unable to create path");
    }
  }

  async function renamePath(path: string) {
    if (!projectId) return;
    const target = window.prompt("Rename/move to path", path);
    if (!target || target === path) return;
    try {
      setWorkspaceError(null);
      await moveProjectFile(projectId, path, target.trim());
      const tree = await getProjectTree(projectId);
      setTreeNodes(tree.nodes);
      if (activePath === path) setActivePath(target.trim());
    } catch {
      setWorkspaceError("Unable to move/rename path");
    }
  }

  async function removePath(path: string) {
    if (!projectId) return;
    if (!window.confirm(`Delete ${path}?`)) return;
    try {
      setWorkspaceError(null);
      await deleteProjectFile(projectId, path);
      const tree = await getProjectTree(projectId);
      setTreeNodes(tree.nodes);
      if (activePath === path) {
        const nextFile = tree.nodes.find((n) => n.kind === "file")?.path ?? "main.typ";
        setActivePath(nextFile);
      }
    } catch {
      setWorkspaceError("Unable to delete path");
    }
  }

  async function handleCreateRevision() {
    if (!projectId || newRevision.trim().length === 0) return;
    await createRevision(projectId, newRevision.trim());
    const res = await listRevisions(projectId);
    setRevisions(res.revisions);
    setNewRevision("");
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

  async function saveCompiledPdfToServer() {
    if (!projectId || !pdfData) return;
    const binary = Array.from(pdfData, (v) => String.fromCharCode(v)).join("");
    const contentBase64 = btoa(binary);
    await uploadProjectPdfArtifact(projectId, {
      entry_file_path: entryFilePath,
      content_base64: contentBase64,
      content_type: "application/pdf"
    });
    window.open(latestProjectPdfUrl(projectId), "_blank");
  }

  async function uploadFontAsset() {
    if (!projectId) return;
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".ttf,.otf,.woff,.woff2";
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const binary = Array.from(bytes, (v) => String.fromCharCode(v)).join("");
      try {
        setWorkspaceError(null);
        await uploadProjectAsset(projectId, {
          path: `fonts/${file.name}`,
          content_base64: btoa(binary),
          content_type: file.type || "font/ttf"
        });
        const tree = await listProjectAssets(projectId);
        const contents = await Promise.all(
          tree.assets
            .filter((asset) => /\.(ttf|otf|woff|woff2)$/i.test(asset.path))
            .map((asset) => getProjectAssetContent(projectId, asset.id))
        );
        setFontData(
          contents.map((item) => {
            const bin = atob(item.content_base64);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
            return out;
          })
        );
      } catch {
        setWorkspaceError("Unable to upload font asset (object storage unavailable or permission denied)");
      }
    };
    picker.click();
  }

  if (!projectId) return <Navigate to="/projects" replace />;
  const project = projects.find((p) => p.id === projectId);
  if (!project && projects.length > 0) {
    navigate(`/project/${projects[0].id}`, { replace: true });
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
            <button className="button" onClick={() => addFile("file")}>
              New File
            </button>
            <button className="button" onClick={() => addFile("directory")}>
              New Dir
            </button>
          </div>
          <div className="tree">
            {treeNodes.map((node) => (
              <div key={`${node.kind}:${node.path}`} className={`tree-node ${node.path === activePath ? "active" : ""}`}>
                <button
                  className="tree-label"
                  onClick={() => node.kind === "file" && setActivePath(node.path)}
                  title={node.path}
                >
                  {node.kind === "directory" ? "📁" : "📄"} {node.path}
                </button>
                <button className="mini" onClick={() => renamePath(node.path)}>
                  Rename
                </button>
                <button className="mini" onClick={() => removePath(node.path)}>
                  Delete
                </button>
              </div>
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
            <span>Entry: {entryFilePath}</span>
            <span>Save: {saveState}</span>
            <span>Compiled: {compiledAt ? new Date(compiledAt).toLocaleTimeString() : "n/a"}</span>
          </div>
          <PresenceBar
            users={presenceUserIds.map((id, idx) => ({
              id,
              name: id === effectiveUserId ? "You" : `Peer ${idx + 1}`,
              color: id === effectiveUserId ? "#1d6fa5" : "#2f8f2f"
            }))}
          />
          <EditorPane value={docText} onChange={updateDocumentViaYjs} />
          {compileErrors.length > 0 && <div className="error">{compileErrors.join("; ")}</div>}
          {workspaceError && <div className="error">{workspaceError}</div>}
        </div>
      </article>
      <aside className="panel right">
        <h2>Preview & Integrations</h2>
        <div className="panel-content">
          <div ref={canvasPreviewRef} className="pdf-frame" />
          <div className="toolbar">
            <button className="button" onClick={downloadCompiledPdf} disabled={!pdfData}>
              Download PDF (Client)
            </button>
            <button className="button" onClick={saveCompiledPdfToServer} disabled={!pdfData}>
              Save PDF Artifact
            </button>
            <a className="button" href={projectArchiveUrl(projectId)} target="_blank" rel="noreferrer">
              Download Archive
            </a>
          </div>
          <div className="toolbar">
            <button className="button" onClick={uploadFontAsset}>
              Upload Font
            </button>
            <button
              className="button"
              onClick={async () => {
                const next = window.prompt("Entry file path", entryFilePath);
                if (!next) return;
                const settings = await upsertProjectSettings(projectId, next.trim());
                setEntryFilePath(settings.entry_file_path);
              }}
            >
              Set Entry File
            </button>
          </div>
          <div className="git-box">
            <strong>Git Access</strong>
            <code>{gitRepoUrl || "Loading..."}</code>
            <small>Use a Personal Access Token as Git HTTP password. Force push is rejected.</small>
          </div>
          <h3>Revision History</h3>
          <div className="toolbar">
            <input
              value={newRevision}
              onChange={(e) => setNewRevision(e.target.value)}
              placeholder="Revision summary"
            />
            <button className="button" onClick={handleCreateRevision}>
              Add Revision
            </button>
          </div>
          <HistoryPanel
            revisions={revisions.map((r) => ({
              id: r.id,
              author: r.actor_user_id ?? "Unknown",
              summary: r.summary,
              createdAt: r.created_at
            }))}
          />
        </div>
      </aside>
    </section>
  );
}

function AdminPage() {
  const [orgId, setOrgId] = useState(DEFAULT_ORG_ID);
  const [mappings, setMappings] = useState<OrgGroupRoleMapping[]>([]);
  const [groupName, setGroupName] = useState("");
  const [role, setRole] = useState<ProjectRole>("Student");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const next = await listOrgGroupRoleMappings(orgId);
      setMappings(next);
      setError(null);
    } catch {
      setMappings([]);
      setError("Unable to load mappings. Org admin permissions required.");
    }
  }

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [orgId]);

  async function save() {
    if (!groupName.trim()) return;
    await upsertOrgGroupRoleMapping(orgId, { group_name: groupName.trim(), role });
    setGroupName("");
    await refresh();
  }

  async function remove(name: string) {
    await deleteOrgGroupRoleMapping(orgId, name);
    await refresh();
  }

  return (
    <section className="page">
      <h2>Admin: OIDC Group Role Mapping</h2>
      <div className="panel-content">
        <div className="toolbar">
          <input value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="Organization ID" />
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="OIDC group value"
          />
          <select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
            <option value="Student">Student</option>
            <option value="TA">TA</option>
            <option value="Teacher">Teacher</option>
            <option value="Owner">Owner</option>
          </select>
          <button className="button" onClick={save}>
            Save
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="card-list">
          {mappings.map((mapping) => (
            <div className="card" key={mapping.group_name}>
              <strong>{mapping.group_name}</strong>
              <span>{mapping.role}</span>
              <button className="button" onClick={() => remove(mapping.group_name)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
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
          <input
            value={tokenLabel}
            onChange={(e) => setTokenLabel(e.target.value)}
            placeholder="Token label"
          />
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
