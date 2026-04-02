import { chromium } from "playwright";

const PROJECT_ID = "c22502ea-ef21-4765-827f-a9cfd1609286";
const PROJECT_URL = `http://localhost:18080/project/${PROJECT_ID}`;
const SIGN_IN_URL = "http://localhost:18080/sign-in";

async function ensureSignedIn(page) {
  await page.goto(SIGN_IN_URL, { waitUntil: "domcontentloaded" });
  const emailInput = page
    .locator('input[placeholder*="Email"], input[placeholder*="邮箱"], input[name="email"], input[type="email"]')
    .first();
  await emailInput.waitFor({ state: "visible", timeout: 20000 });
  await emailInput.fill("test@guozz.cn");
  await page
    .locator('input[placeholder*="Password"], input[placeholder*="密码"], input[name="password"], input[type="password"]')
    .first()
    .fill("001gzz00");
  await page.getByRole("button", { name: /continue|继续/i }).click();
  await page.waitForTimeout(1200);
  await page.goto("http://localhost:18080/projects", { waitUntil: "networkidle" });
  if (page.url().includes("/sign-in")) {
    throw new Error("Sign-in failed in headless run");
  }
}

function readStoredSettings(projectId) {
  const raw = localStorage.getItem(`workspace.preview.settings.${projectId}`);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  await ensureSignedIn(page);
  await page.goto(PROJECT_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(10000);

  const before = await page.evaluate(() => {
    const frame = document.querySelector(".pdf-frame");
    if (!frame) return null;
    const maxTop = Math.max(1, frame.scrollHeight - frame.clientHeight);
    frame.scrollTop = Math.floor(maxTop * 0.71);
    frame.scrollLeft = 0;
    return { top: frame.scrollTop, maxTop, ratio: frame.scrollTop / maxTop };
  });

  await page.waitForTimeout(1400);
  const storedBefore = await page.evaluate(readStoredSettings, PROJECT_ID);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(10000);

  const after = await page.evaluate(() => {
    const frame = document.querySelector(".pdf-frame");
    if (!frame) return null;
    const maxTop = Math.max(1, frame.scrollHeight - frame.clientHeight);
    return { top: frame.scrollTop, maxTop, ratio: frame.scrollTop / maxTop };
  });
  const storedAfter = await page.evaluate(readStoredSettings, PROJECT_ID);

  await page.screenshot({ path: "scripts/preview-position-after-refresh.png", fullPage: true });
  console.log(JSON.stringify({ before, storedBefore, after, storedAfter }, null, 2));

  await browser.close();
}

await main();
