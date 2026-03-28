const CORE_API = process.env.CORE_API_URL ?? "http://127.0.0.1:18080";
const REALTIME_WS = process.env.REALTIME_WS_URL ?? "ws://127.0.0.1:18080";
const runId = Date.now().toString();

const ownerAEmail = `iso-a-${runId}@example.com`;
const ownerBEmail = `iso-b-${runId}@example.com`;
const password = "Owner1234!";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function parseJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function api(method, route, token, body) {
  const res = await fetch(`${CORE_API}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await parseJson(res);
  if (!res.ok) throw new Error(`${method} ${route} failed: ${res.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function register(email, displayName) {
  const emailPrefix = email.split("@")[0] || "user";
  const username = emailPrefix.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32) || `user${Date.now()}`;
  const res = await fetch(`${CORE_API}/v1/auth/local/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      username,
      display_name: displayName
    })
  });
  const payload = await parseJson(res);
  if (!res.ok) throw new Error(`register failed: ${res.status} ${JSON.stringify(payload)}`);
  return payload;
}

function openSocket({ docId, projectId, userId, sessionToken }) {
  const query = new URLSearchParams({
    project_id: projectId,
    user_id: userId,
    session_token: sessionToken
  });
  const url = `${REALTIME_WS}/v1/realtime/ws/${encodeURIComponent(docId)}?${query.toString()}`;
  const ws = new WebSocket(url);
  const received = [];
  ws.addEventListener("message", (event) => {
    try {
      received.push(JSON.parse(String(event.data)));
    } catch {
      // ignore parse failures
    }
  });
  return { ws, received };
}

async function waitForOpen(ws, label) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (ws.readyState === WebSocket.OPEN) return;
    await wait(60);
  }
  throw new Error(`timeout waiting socket open: ${label}`);
}

async function main() {
  const authA = await register(ownerAEmail, "Isolation A");
  const authB = await register(ownerBEmail, "Isolation B");
  const projectA = await api("POST", "/v1/projects", authA.session_token, { name: `Isolation A ${runId}` });
  const projectB = await api("POST", "/v1/projects", authB.session_token, { name: `Isolation B ${runId}` });

  const sharedDocId = "main.typ";
  const a = openSocket({
    docId: sharedDocId,
    projectId: projectA.id,
    userId: authA.user_id,
    sessionToken: authA.session_token
  });
  const b = openSocket({
    docId: sharedDocId,
    projectId: projectB.id,
    userId: authB.user_id,
    sessionToken: authB.session_token
  });

  await waitForOpen(a.ws, "A");
  await waitForOpen(b.ws, "B");
  await wait(150);

  const tokenA = `A-${runId}`;
  const tokenB = `B-${runId}`;
  a.ws.send(JSON.stringify({ kind: "probe.event", payload: { token: tokenA } }));
  b.ws.send(JSON.stringify({ kind: "probe.event", payload: { token: tokenB } }));
  await wait(600);

  const leakedToA = a.received.some((event) => event?.payload?.token === tokenB);
  const leakedToB = b.received.some((event) => event?.payload?.token === tokenA);

  a.ws.close();
  b.ws.close();

  if (leakedToA || leakedToB) {
    throw new Error(`cross-project realtime leak detected (toA=${leakedToA}, toB=${leakedToB})`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectA: projectA.id,
        projectB: projectB.id,
        sharedDocId
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: String(error)
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
