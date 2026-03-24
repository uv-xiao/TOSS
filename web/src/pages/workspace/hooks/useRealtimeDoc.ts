import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import type { EditorChange } from "@/components/EditorPane";
import { bindRealtimeYDoc, type PresencePeer, type RealtimeStatus } from "@/lib/realtime";

type UseRealtimeDocParams = {
  projectId: string;
  activePath: string;
  docs: Record<string, string>;
  workspaceLoaded: boolean;
  isRevisionMode: boolean;
  canWrite: boolean;
  effectiveUserId: string;
  effectiveUserName: string;
};

export function useRealtimeDoc({
  projectId,
  activePath,
  docs,
  workspaceLoaded,
  isRevisionMode,
  canWrite,
  effectiveUserId,
  effectiveUserName
}: UseRealtimeDocParams) {
  const ydocRef = useRef<Y.Doc | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const realtimeRef = useRef<{ close: () => void; sendCursor: (cursor: { line: number; column: number }) => void } | null>(null);
  const lastSavedDocRef = useRef<string>("");

  const [presence, setPresence] = useState<PresencePeer[]>([]);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting");
  const [docText, setDocText] = useState("");

  const hasActiveLiveDoc = useMemo(
    () => Object.prototype.hasOwnProperty.call(docs, activePath),
    [activePath, docs]
  );

  useEffect(() => {
    if (isRevisionMode) return;
    if (!projectId || !activePath) {
      setDocText("");
      return;
    }
    setDocText(docs[activePath] ?? "");
  }, [activePath, docs, isRevisionMode, projectId]);

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
    docs,
    effectiveUserId,
    effectiveUserName,
    hasActiveLiveDoc,
    isRevisionMode,
    projectId,
    workspaceLoaded
  ]);

  function applyDocumentDeltas(changes: EditorChange[]) {
    if (isRevisionMode || !canWrite || changes.length === 0) return;
    const ydoc = ydocRef.current;
    const ytext = ytextRef.current;
    if (!ydoc || !ytext) return;
    ydoc.transact(() => {
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

  return {
    ydocRef,
    ytextRef,
    realtimeRef,
    lastSavedDocRef,
    presence,
    realtimeStatus,
    docText,
    setDocText,
    hasActiveLiveDoc,
    applyDocumentDeltas
  };
}

