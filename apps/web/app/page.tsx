"use client";

import { useEffect, useRef, useState, startTransition } from "react";
import { useDeferredValue } from "react";
import * as Y from "yjs";
import { EditorPane } from "@/components/EditorPane";
import { PresenceBar } from "@/components/PresenceBar";
import { CommentsPanel } from "@/components/CommentsPanel";
import { HistoryPanel } from "@/components/HistoryPanel";
import { compileTypstClientSide, renderTypstVectorToCanvas } from "@/lib/typst";
import { bindRealtimeYDoc } from "@/lib/realtime";
import {
  CORE_API_URL,
  createPersonalAccessToken,
  createComment,
  createRevision,
  deleteProjectGroupRole,
  getProjectAssetContent,
  getAuthMe,
  getGitConfig,
  getGitStatus,
  listPersonalAccessTokens,
  listComments,
  listDocuments,
  listProjectAssets,
  listProjectGroupRoles,
  listProjects,
  listRevisions,
  logout,
  oidcLoginUrl,
  revokePersonalAccessToken,
  triggerGitPull,
  triggerGitPush,
  upsertProjectGroupRole,
  upsertGitConfig,
  upsertDocumentByPath,
  type Comment,
  type CreatePatResponse,
  type GitRemoteConfig,
  type ProjectRole,
  type ProjectGroupRoleBinding,
  type GitSyncState,
  type PersonalAccessTokenInfo,
  type Project,
  type Revision
} from "@/lib/api";

const DEFAULT_DOC = `= Typst Realtime Demo

This is a collaborative document.
`;
const DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000010";

export default function HomePage() {
  const localUserId = "local-user";
  const devUserId =
    process.env.NEXT_PUBLIC_DEV_USER_ID ??
    (typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
      ? "00000000-0000-0000-0000-000000000100"
      : "");
  const ydocRef = useRef<Y.Doc | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const lastSavedDocRef = useRef<string>(DEFAULT_DOC);
  const canvasPreviewRef = useRef<HTMLDivElement | null>(null);
  const [document, setDocument] = useState(DEFAULT_DOC);
  const deferredDocument = useDeferredValue(document);
  const [vectorData, setVectorData] = useState<Uint8Array | null>(null);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [compiledAt, setCompiledAt] = useState<number | null>(null);
  const [fontData, setFontData] = useState<Uint8Array[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>(DEFAULT_PROJECT_ID);
  const [gitStatus, setGitStatus] = useState<GitSyncState | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [gitConfig, setGitConfig] = useState<GitRemoteConfig | null>(null);
  const [gitRemoteInput, setGitRemoteInput] = useState("");
  const [gitBranchInput, setGitBranchInput] = useState("main");
  const [gitBusy, setGitBusy] = useState<"idle" | "saving" | "pulling" | "pushing">("idle");
  const [gitError, setGitError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<PersonalAccessTokenInfo[]>([]);
  const [tokenLabel, setTokenLabel] = useState("CLI token");
  const [tokenExpiresAt, setTokenExpiresAt] = useState("");
  const [newToken, setNewToken] = useState<CreatePatResponse | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [presenceUserIds, setPresenceUserIds] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [newComment, setNewComment] = useState("");
  const [newRevision, setNewRevision] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [groupRoles, setGroupRoles] = useState<ProjectGroupRoleBinding[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupRole, setNewGroupRole] = useState<ProjectRole>("Student");
  const [authUser, setAuthUser] = useState<{
    user_id: string;
    email: string;
    display_name: string;
    session_expires_at: string;
  } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const effectiveUserId = (authUser?.user_id ?? devUserId) || localUserId;

  useEffect(() => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("main");
    ydocRef.current = ydoc;
    ytextRef.current = ytext;
    ydoc.transact(() => {
      ytext.insert(0, DEFAULT_DOC);
    }, "init");

    const unobserve = (event: Y.YTextEvent) => {
      setDocument(event.target.toString());
    };
    ytext.observe(unobserve);

    const realtime = bindRealtimeYDoc({
      docId: `${selectedProject || DEFAULT_PROJECT_ID}:main.typ`,
      projectId: selectedProject || DEFAULT_PROJECT_ID,
      wsBaseUrl:
        process.env.NEXT_PUBLIC_REALTIME_URL ?? "ws://127.0.0.1:18090",
      ydoc,
      userId: effectiveUserId,
      onPresenceChange: setPresenceUserIds
    });

    setDocument(ytext.toString());

    return () => {
      ytext.unobserve(unobserve);
      realtime.close();
      ydoc.destroy();
      ydocRef.current = null;
      ytextRef.current = null;
    };
  }, [effectiveUserId, selectedProject]);

  useEffect(() => {
    getAuthMe()
      .then((me) => setAuthUser(me))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (authLoading) return;
    listProjects()
      .then((data) => {
        setProjects(data.projects);
        if (data.projects.length > 0) {
          setSelectedProject(data.projects[0].id);
        }
      })
      .catch(() => setProjects([]));

    listPersonalAccessTokens()
      .then((res) => setTokens(res.tokens))
      .catch(() => setTokens([]));
  }, [authLoading, authUser?.user_id]);

  useEffect(() => {
    if (!selectedProject) return;
    getGitStatus(selectedProject)
      .then(setGitStatus)
      .catch(() => setGitStatus(null));
    getGitConfig(selectedProject)
      .then((cfg) => {
        setGitConfig(cfg);
        setGitRemoteInput(cfg.remote_url ?? "");
        setGitBranchInput(cfg.default_branch);
      })
      .catch(() => {
        setGitConfig(null);
        setGitRemoteInput("");
      });

    listComments(selectedProject)
      .then((res) => setComments(res.comments))
      .catch(() => setComments([]));

    listRevisions(selectedProject)
      .then((res) => setRevisions(res.revisions))
      .catch(() => setRevisions([]));
    listProjectGroupRoles(selectedProject)
      .then((res) => setGroupRoles(res))
      .catch(() => setGroupRoles([]));
    listProjectAssets(selectedProject)
      .then(async (res) => {
        const fontAssets = res.assets.filter((asset) =>
          /\.(ttf|otf|woff|woff2)$/i.test(asset.path)
        );
        const contents = await Promise.all(
          fontAssets.map((asset) => getProjectAssetContent(selectedProject, asset.id))
        );
        const buffers = contents.map((item) => {
          const binary = atob(item.content_base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          return bytes;
        });
        setFontData(buffers);
      })
      .catch(() => setFontData([]));

    listDocuments(selectedProject)
      .then((res) => {
        const mainDoc = res.documents.find((d) => d.path === "main.typ") ?? res.documents[0];
        if (mainDoc) {
          updateDocumentViaYjs(mainDoc.content);
          lastSavedDocRef.current = mainDoc.content;
        }
      })
      .catch(() => undefined);
  }, [selectedProject]);

  useEffect(() => {
    let cancelled = false;
    startTransition(() => {
      compileTypstClientSide(deferredDocument, {
        coreApiUrl: CORE_API_URL,
        fontData
      }).then((output) => {
        if (cancelled) return;
        setVectorData(output.vectorData);
        setCompileErrors(output.errors);
        setCompiledAt(output.compiledAt);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [deferredDocument, fontData]);

  useEffect(() => {
    const el = canvasPreviewRef.current;
    if (!el || !vectorData) return;
    renderTypstVectorToCanvas(el, vectorData).catch(() => undefined);
  }, [vectorData]);

  useEffect(() => {
    if (!selectedProject) return;
    if (document === lastSavedDocRef.current) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      upsertDocumentByPath(selectedProject, "main.typ", document)
        .then((saved) => {
          lastSavedDocRef.current = saved.content;
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [selectedProject, document]);

  function updateDocumentViaYjs(nextValue: string) {
    const ydoc = ydocRef.current;
    const ytext = ytextRef.current;
    if (!ydoc || !ytext) {
      setDocument(nextValue);
      return;
    }
    if (nextValue === ytext.toString()) return;
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, nextValue);
    });
  }

  async function handleCreateComment() {
    if (!selectedProject || newComment.trim().length === 0) return;
    setActionError(null);
    try {
      await createComment(selectedProject, newComment.trim());
      const res = await listComments(selectedProject);
      setComments(res.comments);
      setNewComment("");
    } catch {
      setActionError("Unable to create comment");
    }
  }

  async function handleCreateRevision() {
    if (!selectedProject || newRevision.trim().length === 0) return;
    setActionError(null);
    try {
      await createRevision(selectedProject, newRevision.trim());
      const res = await listRevisions(selectedProject);
      setRevisions(res.revisions);
      setNewRevision("");
    } catch {
      setActionError("Unable to create revision");
    }
  }

  async function handleSaveGitConfig() {
    if (!selectedProject) return;
    setGitError(null);
    setGitBusy("saving");
    try {
      const cfg = await upsertGitConfig(selectedProject, {
        remote_url: gitRemoteInput.trim() || null,
        default_branch: gitBranchInput.trim() || "main"
      });
      setGitConfig(cfg);
      setGitStatus(await getGitStatus(selectedProject));
    } catch {
      setGitError("Unable to save git config");
    } finally {
      setGitBusy("idle");
    }
  }

  async function handleGitPull() {
    if (!selectedProject) return;
    setGitError(null);
    setGitBusy("pulling");
    try {
      const status = await triggerGitPull(selectedProject);
      setGitStatus(status);
      const docs = await listDocuments(selectedProject);
      const mainDoc = docs.documents.find((d) => d.path === "main.typ") ?? docs.documents[0];
      if (mainDoc) {
        updateDocumentViaYjs(mainDoc.content);
        lastSavedDocRef.current = mainDoc.content;
      }
    } catch {
      setGitError("Git pull failed");
    } finally {
      setGitBusy("idle");
    }
  }

  async function handleGitPush() {
    if (!selectedProject) return;
    setGitError(null);
    setGitBusy("pushing");
    try {
      const status = await triggerGitPush(selectedProject);
      setGitStatus(status);
    } catch {
      setGitError("Git push failed");
    } finally {
      setGitBusy("idle");
    }
  }

  async function refreshTokens() {
    try {
      const res = await listPersonalAccessTokens();
      setTokens(res.tokens);
    } catch {
      setTokens([]);
    }
  }

  async function handleCreateToken() {
    if (tokenLabel.trim().length === 0) return;
    setTokenError(null);
    try {
      const created = await createPersonalAccessToken({
        label: tokenLabel.trim(),
        expires_at: tokenExpiresAt.trim() || null
      });
      setNewToken(created);
      await refreshTokens();
    } catch {
      setTokenError("Unable to create access token");
    }
  }

  async function handleRevokeToken(tokenId: string) {
    setTokenError(null);
    try {
      await revokePersonalAccessToken(tokenId);
      await refreshTokens();
    } catch {
      setTokenError("Unable to revoke token");
    }
  }

  async function handleLogout() {
    await logout();
    setAuthUser(null);
    setProjects([]);
    setSelectedProject("");
    setTokens([]);
  }

  async function refreshGroupRoles() {
    if (!selectedProject) return;
    try {
      const next = await listProjectGroupRoles(selectedProject);
      setGroupRoles(next);
    } catch {
      setGroupRoles([]);
    }
  }

  async function handleUpsertGroupRole() {
    if (!selectedProject) return;
    if (!newGroupName.trim()) return;
    setActionError(null);
    try {
      await upsertProjectGroupRole(selectedProject, {
        group_name: newGroupName.trim(),
        role: newGroupRole
      });
      await refreshGroupRoles();
      setNewGroupName("");
    } catch {
      setActionError("Unable to save OIDC group mapping");
    }
  }

  async function handleDeleteGroupRole(groupName: string) {
    if (!selectedProject) return;
    setActionError(null);
    try {
      await deleteProjectGroupRole(selectedProject, groupName);
      await refreshGroupRoles();
    } catch {
      setActionError("Unable to delete OIDC group mapping");
    }
  }

  return (
    <main className="app">
      <header className="topbar">
        <strong>Typst School Collaboration</strong>
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
        <PresenceBar
          users={presenceUserIds.map((id, idx) => ({
            id,
            name: id === effectiveUserId ? "You" : `Peer ${idx + 1}`,
            color: id === effectiveUserId ? "#1d6fa5" : "#2f8f2f"
          }))}
        />
      </header>
      <section className="workspace">
        <article className="panel">
          <h2>Editor</h2>
          <div className="panel-content">
            <div className="meta">
              <span>
                Project:
                <select
                  value={selectedProject}
                  onChange={(e) => setSelectedProject(e.target.value)}
                  style={{ marginLeft: 8 }}
                >
                  {projects.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </span>
              <span>Compiled: {compiledAt ? new Date(compiledAt).toLocaleTimeString() : "n/a"}</span>
              <span>Save: {saveState}</span>
            </div>
            <EditorPane value={document} onChange={updateDocumentViaYjs} />
            {compileErrors.length > 0 && <div className="error">{compileErrors.join("; ")}</div>}
          </div>
        </article>
        <article className="panel">
          <h2>Canvas Preview + Project Signals</h2>
          <div className="panel-content">
            <div
              ref={canvasPreviewRef}
              className="pdf-frame"
              style={{ overflow: "auto", background: "#f8fafc", padding: 8 }}
            />
            <hr />
            <div className="meta">
              <span>Git Branch: {gitStatus?.branch ?? "main"}</span>
              <span>Status: {gitStatus?.status ?? "unknown"}</span>
              <span>Conflicts: {gitStatus?.has_conflicts ? "yes" : "no"}</span>
            </div>
            <div className="meta">
              <input
                value={gitRemoteInput}
                onChange={(e) => setGitRemoteInput(e.target.value)}
                placeholder="Remote URL (e.g., https://... or /tmp/remote.git)"
                style={{ flex: 1, padding: 6 }}
              />
              <input
                value={gitBranchInput}
                onChange={(e) => setGitBranchInput(e.target.value)}
                placeholder="Branch"
                style={{ width: 120, padding: 6 }}
              />
              <button className="button" onClick={handleSaveGitConfig} disabled={gitBusy !== "idle"}>
                {gitBusy === "saving" ? "Saving..." : "Save Git Config"}
              </button>
            </div>
            <div className="meta">
              <span>Local Mirror: {gitConfig?.local_path ?? "n/a"}</span>
              <button className="button" onClick={handleGitPull} disabled={gitBusy !== "idle"}>
                {gitBusy === "pulling" ? "Pulling..." : "Pull"}
              </button>
              <button className="button" onClick={handleGitPush} disabled={gitBusy !== "idle"}>
                {gitBusy === "pushing" ? "Pushing..." : "Push"}
              </button>
            </div>
            {gitError && <div className="error">{gitError}</div>}
            <h3>Comments</h3>
            <div className="meta">
              <input
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add a comment"
                style={{ flex: 1, padding: 6 }}
              />
              <button className="button" onClick={handleCreateComment}>
                Add
              </button>
            </div>
            <CommentsPanel
              comments={comments.map((c) => ({
                id: c.id,
                author: c.actor_user_id ?? "Unknown",
                body: c.body,
                createdAt: c.created_at
              }))}
            />
            <h3>Revision History</h3>
            <div className="meta">
              <input
                value={newRevision}
                onChange={(e) => setNewRevision(e.target.value)}
                placeholder="Revision summary"
                style={{ flex: 1, padding: 6 }}
              />
              <button className="button" onClick={handleCreateRevision}>
                Commit Revision
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
            <h3>OIDC Group Role Mapping</h3>
            <div className="meta">
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="OIDC group (claim value)"
                style={{ flex: 1, padding: 6 }}
              />
              <select
                value={newGroupRole}
                onChange={(e) => setNewGroupRole(e.target.value as ProjectRole)}
                style={{ padding: 6 }}
              >
                <option value="Student">Student</option>
                <option value="TA">TA</option>
                <option value="Teacher">Teacher</option>
                <option value="Owner">Owner</option>
              </select>
              <button className="button" onClick={handleUpsertGroupRole}>
                Save Mapping
              </button>
            </div>
            {groupRoles.map((g) => (
              <div key={g.group_name} className="meta" style={{ justifyContent: "space-between" }}>
                <span>
                  {g.group_name} → {g.role}
                </span>
                <button className="button" onClick={() => handleDeleteGroupRole(g.group_name)}>
                  Remove
                </button>
              </div>
            ))}
            <h3>Security Settings: Access Tokens</h3>
            <div className="meta">
              <input
                value={tokenLabel}
                onChange={(e) => setTokenLabel(e.target.value)}
                placeholder="Token label"
                style={{ flex: 1, padding: 6 }}
              />
              <input
                value={tokenExpiresAt}
                onChange={(e) => setTokenExpiresAt(e.target.value)}
                placeholder="Expires at (RFC3339, optional)"
                style={{ flex: 1, padding: 6 }}
              />
              <button className="button" onClick={handleCreateToken}>
                Create token
              </button>
            </div>
            {newToken && (
              <div className="error">
                New token (shown once): <code>{newToken.token}</code>
              </div>
            )}
            {tokens.map((t) => (
              <div key={t.id} className="meta" style={{ justifyContent: "space-between" }}>
                <span>
                  {t.label} ({t.token_prefix}...) last used:{" "}
                  {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "never"}
                </span>
                <button className="button" onClick={() => handleRevokeToken(t.id)}>
                  Revoke
                </button>
              </div>
            ))}
            {tokenError && <div className="error">{tokenError}</div>}
            {actionError && <div className="error">{actionError}</div>}
          </div>
        </article>
      </section>
    </main>
  );
}
