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

export function bindRealtimeYDoc(params: {
  docId: string;
  projectId: string;
  wsBaseUrl: string;
  ydoc: Y.Doc;
  userId?: string;
  sessionToken?: string;
  onPresenceChange?: (users: string[]) => void;
}) {
  const userId = params.userId ?? crypto.randomUUID();
  const query = new URLSearchParams({
    project_id: params.projectId,
    user_id: userId
  });
  if (params.sessionToken?.trim()) {
    query.set("session_token", params.sessionToken.trim());
  }
  const url = `${params.wsBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/v1/realtime/ws/${params.docId}?${query.toString()}`;
  const ws = new WebSocket(url);
  const origin = `client-${crypto.randomUUID()}`;
  const presenceUsers = new Set<string>([userId]);

  const notifyPresence = () => {
    params.onPresenceChange?.(Array.from(presenceUsers));
  };

  const onLocalUpdate = (update: Uint8Array, updateOrigin: unknown) => {
    if (updateOrigin === "remote") return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        kind: "yjs.update",
        origin,
        payload: uint8ToBase64(update)
      })
    );
  };

  params.ydoc.on("update", onLocalUpdate);

  ws.addEventListener("open", () => {
    const snapshot = Y.encodeStateAsUpdate(params.ydoc);
    notifyPresence();
    ws.send(
      JSON.stringify({
        kind: "yjs.sync",
        origin,
        payload: uint8ToBase64(snapshot)
      })
    );
  });

  ws.addEventListener("message", (event) => {
    try {
      const parsed = JSON.parse(String(event.data));
      const incoming = parsed?.payload;
      const kind = parsed?.kind;
      const eventUserId = parsed?.user_id;
      if (kind === "presence.join" && typeof eventUserId === "string") {
        presenceUsers.add(eventUserId);
        notifyPresence();
        if (eventUserId !== userId && ws.readyState === WebSocket.OPEN) {
          const snapshot = Y.encodeStateAsUpdate(params.ydoc);
          ws.send(
            JSON.stringify({
              kind: "yjs.sync",
              origin,
              payload: uint8ToBase64(snapshot)
            })
          );
        }
      }
      if (kind === "presence.leave" && typeof eventUserId === "string") {
        presenceUsers.delete(eventUserId);
        notifyPresence();
      }
      if ((kind === "doc.update" || kind === "yjs.update" || kind === "yjs.sync") && incoming) {
        const maybePayload = typeof incoming === "string" ? incoming : incoming.payload;
        if (typeof maybePayload === "string") {
          Y.applyUpdate(params.ydoc, base64ToUint8(maybePayload), "remote");
        }
      }
    } catch {
      // Ignore malformed events.
    }
  });

  const close = () => {
    params.ydoc.off("update", onLocalUpdate);
    presenceUsers.clear();
    notifyPresence();
    ws.close();
  };

  return { close };
}
