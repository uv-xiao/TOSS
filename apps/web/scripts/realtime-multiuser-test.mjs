import * as Y from "yjs";

const CORE_API = process.env.CORE_API_URL ?? "http://127.0.0.1:18080";
const REALTIME_WS = process.env.REALTIME_WS_URL ?? "ws://127.0.0.1:18090";
const PROJECT_ID = process.env.PROJECT_ID ?? "00000000-0000-0000-0000-000000000010";
const DOC_PATH = "main.typ";
const DOC_ID = `${PROJECT_ID}:${DOC_PATH}`;
const USER_A = "00000000-0000-0000-0000-000000000100";
const USER_B = "00000000-0000-0000-0000-000000000101";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toBase64(update) {
  return Buffer.from(update).toString("base64");
}

function fromBase64(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

async function api(method, path, userId, body) {
  const response = await fetch(`${CORE_API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-user-id": userId
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function connectClient(userId) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("main");
  const query = new URLSearchParams({
    project_id: PROJECT_ID,
    user_id: userId
  });
  const wsUrl = `${REALTIME_WS}/v1/realtime/ws/${encodeURIComponent(DOC_ID)}?${query.toString()}`;
  const ws = new WebSocket(wsUrl);
  const origin = `test-${userId}`;
  const presence = new Set([userId]);

  ws.addEventListener("open", () => {
    const snapshot = Y.encodeStateAsUpdate(ydoc);
    ws.send(JSON.stringify({ kind: "yjs.sync", origin, payload: toBase64(snapshot) }));
  });

  ydoc.on("update", (update, updateOrigin) => {
    if (updateOrigin === "remote") return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ kind: "yjs.update", origin, payload: toBase64(update) }));
  });

  ws.addEventListener("message", (event) => {
    const parsed = JSON.parse(String(event.data));
    const kind = parsed?.kind;
    const payload = parsed?.payload;
    const eventUser = parsed?.user_id;
    if (kind === "presence.join" && typeof eventUser === "string") presence.add(eventUser);
    if (kind === "presence.join" && typeof eventUser === "string" && eventUser !== userId) {
      if (ws.readyState === WebSocket.OPEN) {
        const snapshot = Y.encodeStateAsUpdate(ydoc);
        ws.send(JSON.stringify({ kind: "yjs.sync", origin, payload: toBase64(snapshot) }));
      }
    }
    if (kind === "presence.leave" && typeof eventUser === "string") presence.delete(eventUser);
    if (kind === "doc.update" || kind === "yjs.update" || kind === "yjs.sync") {
      const maybePayload = typeof payload === "string" ? payload : payload?.payload;
      if (typeof maybePayload === "string") {
        Y.applyUpdate(ydoc, fromBase64(maybePayload), "remote");
      }
    }
  });

  return {
    userId,
    ydoc,
    ytext,
    ws,
    presence,
    close() {
      ws.close();
      ydoc.destroy();
    }
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  await api(
    "PUT",
    `/v1/projects/${PROJECT_ID}/documents/by-path/${encodeURIComponent(DOC_PATH)}`,
    USER_A,
    { content: "= Realtime QA\n\nSeed.\n" }
  );

  const a = connectClient(USER_A);
  const b = connectClient(USER_B);

  await waitFor(() => a.ws.readyState === WebSocket.OPEN && b.ws.readyState === WebSocket.OPEN, 5000, "socket open");
  await waitFor(() => a.presence.has(USER_B) && b.presence.has(USER_A), 5000, "mutual presence");

  a.ydoc.transact(() => {
    a.ytext.delete(0, a.ytext.length);
    a.ytext.insert(0, "= Realtime QA\n\nEdited by A.\n");
  }, "A1");
  await waitFor(() => b.ytext.toString().includes("Edited by A."), 5000, "A update visible on B");

  b.ydoc.transact(() => {
    b.ytext.insert(b.ytext.length, "Edited by B.\n");
  }, "B1");
  await waitFor(() => a.ytext.toString().includes("Edited by B."), 5000, "B update visible on A");

  const merged = a.ytext.toString();
  if (merged !== b.ytext.toString()) {
    throw new Error("divergence after concurrent edits");
  }

  b.ws.close();
  await wait(300);
  const b2 = connectClient(USER_B);
  await waitFor(() => b2.ws.readyState === WebSocket.OPEN, 5000, "B reconnect open");
  await waitFor(() => b2.ytext.toString().includes("Edited by A.") && b2.ytext.toString().includes("Edited by B."), 5000, "B reconnect state sync");

  const result = {
    ok: true,
    userA_presence: Array.from(a.presence),
    userB_presence: Array.from(b2.presence),
    final_text: b2.ytext.toString()
  };
  console.log(JSON.stringify(result, null, 2));

  a.close();
  b2.close();
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
});
