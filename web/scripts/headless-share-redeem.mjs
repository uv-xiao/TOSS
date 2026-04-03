import { chromium, request } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:18080";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "test@guozz.cn";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "001gzz00";
const RECIP_EMAIL = process.env.RECIP_EMAIL || "test2@guozz.cn";
const RECIP_PASSWORD = process.env.RECIP_PASSWORD || "001gzz00";

async function login(api, email, password) {
  const res = await api.post(`${BASE}/v1/auth/local/login`, {
    data: { email, password }
  });
  if (!res.ok()) {
    throw new Error(`login failed for ${email}: ${res.status()} ${await res.text()}`);
  }
}

async function main() {
  const ownerApi = await request.newContext({ baseURL: BASE });
  await login(ownerApi, OWNER_EMAIL, OWNER_PASSWORD);
  const projectsRes = await ownerApi.get(`${BASE}/v1/projects`);
  if (!projectsRes.ok()) {
    throw new Error(`owner list projects failed: ${projectsRes.status()} ${await projectsRes.text()}`);
  }
  const projectsPayload = await projectsRes.json();
  const ownerProject = (projectsPayload.projects || []).find((p) => !p.archived);
  if (!ownerProject) {
    throw new Error("owner has no non-archived project to share");
  }
  const shareRes = await ownerApi.post(`${BASE}/v1/projects/${ownerProject.id}/share-links`, {
    data: { permission: "read" }
  });
  if (!shareRes.ok()) {
    throw new Error(`create share link failed: ${shareRes.status()} ${await shareRes.text()}`);
  }
  const sharePayload = await shareRes.json();
  const token = sharePayload.token;
  if (!token) {
    throw new Error("missing share token from create-share response");
  }
  console.log(`using project=${ownerProject.id} token=${token.slice(0, 12)}...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  const joinHits = [];
  page.on("requestfinished", (req) => {
    if (req.url().includes("/v1/share/") && req.url().includes("/join")) {
      joinHits.push(req.url());
    }
  });

  const recipApi = context.request;
  await login(recipApi, RECIP_EMAIL, RECIP_PASSWORD);
  await page.goto(`${BASE}/share/${token}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/share-redeem-debug.png", fullPage: true });
  console.log(`join requests observed: ${joinHits.length}`);

  const recipProjectsRes = await recipApi.get(`${BASE}/v1/projects`);
  if (!recipProjectsRes.ok()) {
    throw new Error(`recipient list projects failed: ${recipProjectsRes.status()} ${await recipProjectsRes.text()}`);
  }
  const recipProjects = await recipProjectsRes.json();
  const joined = (recipProjects.projects || []).some((p) => p.id === ownerProject.id);
  console.log(`recipient has project after share visit: ${joined}`);
  if (!joined) {
    throw new Error("share visit did not add project to recipient list");
  }

  await browser.close();
  await ownerApi.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
