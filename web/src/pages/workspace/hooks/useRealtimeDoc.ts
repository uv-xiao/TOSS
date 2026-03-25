import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import type { EditorChange } from "@/components/EditorPane";
import { bindRealtimeYDoc, type PresencePeer, type RealtimeStatus, type ReconnectState } from "@/lib/realtime";

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
  const realtimeRef = useRef<{
    close: () => void;
    sendCursor: (cursor: { line: number; column: number }) => void;
    reconnectNow: () => void;
  } | null>(null);
  const lastSavedDocRef = useRef<string>("");
  const activeBindingRef = useRef<string>("");

  const [presence, setPresence] = useState<PresencePeer[]>([]);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting");
  const [reconnectState, setReconnectState] = useState<ReconnectState>({
    active: false,
    secondsRemaining: 0
  });
  const [docText, setDocText] = useState("");
  const [realtimeDocReady, setRealtimeDocReady] = useState(false);

  const hasActiveLiveDoc = useMemo(
    () => Object.prototype.hasOwnProperty.call(docs, activePath),
    [activePath, docs]
  );
  const activeFileContent = docs[activePath] ?? "";

  useEffect(() => {
    if (isRevisionMode) return;
    if (!projectId || !activePath) {
      activeBindingRef.current = "";
      setDocText("");
      setRealtimeDocReady(false);
      return;
    }
    const nextBinding = `${projectId}:${activePath}`;
    if (activeBindingRef.current !== nextBinding) {
      activeBindingRef.current = nextBinding;
      setDocText("");
      setRealtimeDocReady(false);
    }
  }, [activePath, isRevisionMode, projectId]);

  useEffect(() => {
    if (!projectId || !activePath || isRevisionMode || !workspaceLoaded) return;
    if (!hasActiveLiveDoc) {
      setPresence([]);
      setDocText("");
      setRealtimeDocReady(false);
      setRealtimeStatus("disconnected");
      setReconnectState({ active: false, secondsRemaining: 0 });
      return;
    }
    const fileContent = activeFileContent;
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("main");
    ydocRef.current = ydoc;
    ytextRef.current = ytext;
    let bootstrapResolved = false;
    let fallbackTimer: number | null = null;
    setDocText("");
    setRealtimeDocReady(false);
    lastSavedDocRef.current = "";

    const resolveBootstrap = () => {
      if (bootstrapResolved) return;
      bootstrapResolved = true;
      const current = ytext.toString();
      if (!current && fileContent) {
        ydoc.transact(() => {
          ytext.insert(0, fileContent);
        }, "bootstrap-seed");
      } else {
        setDocText(current);
      }
      lastSavedDocRef.current = ytext.toString();
      setRealtimeDocReady(true);
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };

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
      onStatusChange: setRealtimeStatus,
      onReconnectChange: setReconnectState,
      onBootstrapDone: resolveBootstrap
    });
    fallbackTimer = window.setTimeout(resolveBootstrap, 1200);
    realtimeRef.current = realtime;
    return () => {
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      ytext.unobserve(observer);
      realtime.close();
      ydoc.destroy();
      ydocRef.current = null;
      ytextRef.current = null;
      realtimeRef.current = null;
      setPresence([]);
      setRealtimeDocReady(false);
      setRealtimeStatus("disconnected");
      setReconnectState({ active: false, secondsRemaining: 0 });
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
    reconnectState,
    docText,
    setDocText,
    realtimeDocReady,
    hasActiveLiveDoc,
    applyDocumentDeltas
  };
}
