"use client";

import { useEffect, useRef, useState, startTransition } from "react";
import { useDeferredValue } from "react";
import * as Y from "yjs";
import { EditorPane } from "@/components/EditorPane";
import { PresenceBar } from "@/components/PresenceBar";
import { CommentsPanel } from "@/components/CommentsPanel";
import { HistoryPanel } from "@/components/HistoryPanel";
import { compileTypstClientSide } from "@/lib/typst";
import { bindRealtimeYDoc } from "@/lib/realtime";
import {
  createComment,
  createRevision,
  getGitConfig,
  getGitStatus,
  listComments,
  listDocuments,
  listProjects,
  listRevisions,
  triggerGitPull,
  triggerGitPush,
  upsertGitConfig,
  upsertDocumentByPath,
  type Comment,
  type GitRemoteConfig,
  type GitSyncState,
  type Project,
  type Revision
} from "@/lib/api";

const DEFAULT_DOC = `= Typst Realtime Demo

This is a collaborative document.
`;

export default function HomePage() {
  const userId = "00000000-0000-0000-0000-000000000100";
  const ydocRef = useRef<Y.Doc | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const lastSavedDocRef = useRef<string>(DEFAULT_DOC);
  const [document, setDocument] = useState(DEFAULT_DOC);
  const deferredDocument = useDeferredValue(document);
  const [pdfDataUrl, setPdfDataUrl] = useState<string | null>(null);
  const [compileErrors, setCompileErrors] = useState<string[]>([]);
  const [compiledAt, setCompiledAt] = useState<number | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [gitStatus, setGitStatus] = useState<GitSyncState | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [gitConfig, setGitConfig] = useState<GitRemoteConfig | null>(null);
  const [gitRemoteInput, setGitRemoteInput] = useState("");
  const [gitBranchInput, setGitBranchInput] = useState("main");
  const [gitBusy, setGitBusy] = useState<"idle" | "saving" | "pulling" | "pushing">("idle");
  const [gitError, setGitError] = useState<string | null>(null);
  const [presenceUserIds, setPresenceUserIds] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [newComment, setNewComment] = useState("");
  const [newRevision, setNewRevision] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

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
      docId: "demo-main-typ",
      wsBaseUrl: process.env.NEXT_PUBLIC_REALTIME_URL ?? "ws://localhost:8090",
      ydoc,
      userId,
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
  }, []);

  useEffect(() => {
    listProjects()
      .then((data) => {
        setProjects(data.projects);
        if (data.projects.length > 0) {
          setSelectedProject(data.projects[0].id);
        }
      })
      .catch(() => setProjects([]));
  }, []);

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
      compileTypstClientSide(deferredDocument).then((output) => {
        if (cancelled) return;
        setPdfDataUrl(output.pdfDataUrl);
        setCompileErrors(output.errors);
        setCompiledAt(output.compiledAt);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [deferredDocument]);

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

  return (
    <main className="app">
      <header className="topbar">
        <strong>Typst School Collaboration</strong>
        <PresenceBar
          users={presenceUserIds.map((id, idx) => ({
            id,
            name: id === userId ? "You" : `Peer ${idx + 1}`,
            color: id === userId ? "#1d6fa5" : "#2f8f2f"
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
          <h2>PDF Preview + Project Signals</h2>
          <div className="panel-content">
            {pdfDataUrl ? (
              <iframe src={pdfDataUrl} className="pdf-frame" title="Typst PDF Preview" />
            ) : (
              <div className="error">No PDF generated yet.</div>
            )}
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
            {actionError && <div className="error">{actionError}</div>}
          </div>
        </article>
      </section>
    </main>
  );
}
