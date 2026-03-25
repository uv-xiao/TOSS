import * as Y from "yjs";

function uint8ToBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 1) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function base64ToUint8(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export type PresencePeer = {
  id: string;
  name: string;
  line?: number;
  column?: number;
};

export type RealtimeStatus = "connecting" | "connected" | "disconnected";
export type ReconnectState = {
  active: boolean;
  secondsRemaining: number;
};

type CursorPayload = {
  line: number;
  column: number;
};

export function bindRealtimeYDoc(params: {
  docId: string;
  projectId: string;
  wsBaseUrl: string;
  ydoc: Y.Doc;
  userId?: string;
  userName?: string;
  sessionToken?: string;
  onPresenceChange?: (users: PresencePeer[]) => void;
  onStatusChange?: (status: RealtimeStatus) => void;
  onReconnectChange?: (state: ReconnectState) => void;
  onBootstrapDone?: () => void;
  reconnectDelaySeconds?: number;
}) {
  const userId = params.userId ?? crypto.randomUUID();
  const userName = params.userName?.trim() || `User-${userId.slice(0, 8)}`;
  const reconnectDelaySeconds = Math.max(1, Math.floor(params.reconnectDelaySeconds ?? 5));
  const query = new URLSearchParams({
    project_id: params.projectId,
    user_id: userId,
    user_name: userName
  });
  if (params.sessionToken?.trim()) {
    query.set("session_token", params.sessionToken.trim());
  }
  const safeDocId = encodeURIComponent(params.docId);
  const url = `${params.wsBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/v1/realtime/ws/${safeDocId}?${query.toString()}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectCountdownTimer: number | null = null;
  let reconnectAttemptTimer: number | null = null;
  let reconnectSecondsRemaining = 0;
  const origin = `client-${crypto.randomUUID()}`;
  const peers = new Map<string, PresencePeer>();
  peers.set(userId, { id: userId, name: userName });

  const notifyPresence = () => {
    params.onPresenceChange?.(Array.from(peers.values()));
  };

  const resetPresenceToSelf = () => {
    peers.clear();
    peers.set(userId, { id: userId, name: userName });
    notifyPresence();
  };

  const notifyReconnect = (active: boolean, secondsRemaining: number) => {
    params.onReconnectChange?.({ active, secondsRemaining });
  };

  const stopReconnectCountdown = () => {
    if (reconnectCountdownTimer !== null) {
      window.clearInterval(reconnectCountdownTimer);
      reconnectCountdownTimer = null;
    }
    if (reconnectAttemptTimer !== null) {
      window.clearTimeout(reconnectAttemptTimer);
      reconnectAttemptTimer = null;
    }
    reconnectSecondsRemaining = 0;
    notifyReconnect(false, 0);
  };

  const startReconnectCountdown = () => {
    if (closed) return;
    if (reconnectAttemptTimer !== null) return;
    params.onStatusChange?.("disconnected");
    resetPresenceToSelf();
    reconnectSecondsRemaining = reconnectDelaySeconds;
    notifyReconnect(true, reconnectSecondsRemaining);
    reconnectCountdownTimer = window.setInterval(() => {
      if (closed) return;
      reconnectSecondsRemaining = Math.max(0, reconnectSecondsRemaining - 1);
      notifyReconnect(true, reconnectSecondsRemaining);
    }, 1000);
    reconnectAttemptTimer = window.setTimeout(() => {
      if (closed) return;
      stopReconnectCountdown();
      connect();
    }, reconnectDelaySeconds * 1000);
  };

  const onLocalUpdate = (update: Uint8Array, updateOrigin: unknown) => {
    if (updateOrigin === "remote") return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        kind: "yjs.update",
        origin,
        payload: uint8ToBase64(update)
      })
    );
  };

  params.ydoc.on("update", onLocalUpdate);

  const connect = () => {
    if (closed) return;
    stopReconnectCountdown();
    params.onStatusChange?.("connecting");
    const socket = new WebSocket(url);
    ws = socket;

    socket.addEventListener("open", () => {
      if (closed || ws !== socket) return;
      params.onStatusChange?.("connected");
      stopReconnectCountdown();
      const snapshot = Y.encodeStateAsUpdate(params.ydoc);
      notifyPresence();
      socket.send(
        JSON.stringify({
          kind: "presence.meta",
          origin,
          payload: { user_name: userName }
        })
      );
      socket.send(
        JSON.stringify({
          kind: "yjs.sync",
          origin,
          payload: uint8ToBase64(snapshot)
        })
      );
    });

    socket.addEventListener("message", (event) => {
      if (closed || ws !== socket) return;
      try {
        const parsed = JSON.parse(String(event.data));
        const incoming = parsed?.payload;
        const kind = parsed?.kind;
        const eventUserId = typeof parsed?.user_id === "string" ? parsed.user_id : "";
        const payloadUserName =
          typeof incoming?.user_name === "string" ? incoming.user_name : undefined;

        if (kind === "presence.join" && eventUserId) {
          peers.set(eventUserId, {
            id: eventUserId,
            name: payloadUserName || peers.get(eventUserId)?.name || eventUserId
          });
          notifyPresence();
          if (eventUserId !== userId && socket.readyState === WebSocket.OPEN) {
            const snapshot = Y.encodeStateAsUpdate(params.ydoc);
            socket.send(
              JSON.stringify({
                kind: "yjs.sync",
                origin,
                payload: uint8ToBase64(snapshot)
              })
            );
          }
        }
        if (kind === "presence.leave" && eventUserId) {
          peers.delete(eventUserId);
          notifyPresence();
        }
        if (kind === "presence.meta" && eventUserId) {
          const previous: PresencePeer = peers.get(eventUserId) ?? { id: eventUserId, name: eventUserId };
          peers.set(eventUserId, {
            ...previous,
            name: payloadUserName || previous.name
          });
          notifyPresence();
        }
        if (kind === "presence.cursor" && eventUserId) {
          const previous: PresencePeer = peers.get(eventUserId) ?? { id: eventUserId, name: eventUserId };
          peers.set(eventUserId, {
            ...previous,
            name: payloadUserName || previous.name,
            line:
              typeof incoming?.line === "number" && Number.isFinite(incoming.line)
                ? Math.max(1, incoming.line)
                : previous.line,
            column:
              typeof incoming?.column === "number" && Number.isFinite(incoming.column)
                ? Math.max(1, incoming.column)
                : previous.column
          });
          notifyPresence();
        }
        if ((kind === "doc.update" || kind === "yjs.update" || kind === "yjs.sync") && incoming) {
          const maybePayload = typeof incoming === "string" ? incoming : incoming.payload;
          if (typeof maybePayload === "string") {
            Y.applyUpdate(params.ydoc, base64ToUint8(maybePayload), "remote");
          }
        }
        if (kind === "bootstrap.done") {
          params.onBootstrapDone?.();
        }
      } catch {
        // Ignore malformed events.
      }
    });

    const handleDisconnect = () => {
      if (closed || ws !== socket) return;
      startReconnectCountdown();
    };

    socket.addEventListener("error", handleDisconnect);
    socket.addEventListener("close", handleDisconnect);
  };

  notifyReconnect(false, 0);
  connect();

  const sendCursor = (cursor: CursorPayload) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        kind: "presence.cursor",
        origin,
        payload: {
          ...cursor,
          user_name: userName
        }
      })
    );
  };

  const reconnectNow = () => {
    if (closed) return;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect();
      return;
    }
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) return;
    if (ws.readyState === WebSocket.CLOSING) return;
    connect();
  };

  const close = () => {
    closed = true;
    stopReconnectCountdown();
    params.ydoc.off("update", onLocalUpdate);
    peers.clear();
    notifyPresence();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
    ws = null;
    params.onStatusChange?.("disconnected");
  };

  return { close, sendCursor, reconnectNow };
}
