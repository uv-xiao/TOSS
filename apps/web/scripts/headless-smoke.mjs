import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? baseUrl;
const projectId = process.env.PROJECT_ID ?? "00000000-0000-0000-0000-000000000010";
const adminId = "00000000-0000-0000-0000-000000000100";
const memberId = "00000000-0000-0000-0000-000000000101";
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-headless";
const fontPath =
  process.env.FONT_FILE_PATH ??
  "/Users/zizhengguo/projects/typst/apps/web/public/typst-fonts/NotoSans-Regular.ttf";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, route, userId, body) {
  const res = await fetch(`${coreApi}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-user-id": userId
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${route} failed (${res.status}): ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

async function uploadAsset(pathName, bytes, contentType) {
  return api("POST", `/v1/projects/${projectId}/assets`, adminId, {
    path: pathName,
    content_base64: Buffer.from(bytes).toString("base64"),
    content_type: contentType
  });
}

async function canvasChecksum(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".pdf-frame canvas");
    if (!canvas) return 0;
    const ctx = canvas.getContext("2d");
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 2048) {
      sum = (sum * 31 + data[i] + data[i + 1] + data[i + 2]) >>> 0;
    }
    return sum;
  });
}

async function waitForCanvas(page, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const errors = await page.locator(".error").allInnerTexts();
    if (errors.some((text) => /Project has no source documents/i.test(text))) {
      await wait(300);
      continue;
    }
    if ((await page.locator(".pdf-frame canvas").count()) > 0) return;
    await wait(400);
  }
  const errors = await page.locator(".error").allInnerTexts();
  throw new Error(`Canvas not rendered within timeout. Errors: ${errors.join(" | ")}`);
}

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const admin = await browser.newPage({ viewport: { width: 1620, height: 1020 } });
const member = await browser.newPage({ viewport: { width: 1620, height: 1020 } });
const browserErrors = [];
for (const page of [admin, member]) {
  page.on("console", (msg) => {
    if (msg.type() === "error") browserErrors.push(`console:${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    browserErrors.push(`pageerror:${String(err)}`);
  });
}

const artifacts = [];
try {
  const fontBytes = new Uint8Array(await fs.readFile(fontPath));
  const simpleSvg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#2f7d4a"/></svg>'
  );
  let packageProxyOk = false;
  try {
    const [idx, tar] = await Promise.all([
      fetch(`${coreApi}/v1/typst/packages/preview/index.json`),
      fetch(`${coreApi}/v1/typst/packages/preview/cetz-0.4.2.tar.gz`)
    ]);
    packageProxyOk = idx.ok && tar.ok;
  } catch {
    packageProxyOk = false;
  }

  await api("POST", `/v1/projects/${projectId}/files`, adminId, { path: "chapters", kind: "directory" });
  await api("POST", `/v1/projects/${projectId}/files`, adminId, { path: "figures", kind: "directory" });
  await api("POST", `/v1/projects/${projectId}/files`, adminId, { path: "fonts", kind: "directory" });
  await api(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("chapters/intro.typ")}`,
    adminId,
    {
      content: "#let intro = [Realtime include content.]"
    }
  );
  await api(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
    adminId,
    {
      content: [
        '#import "@preview/cetz:0.4.2": *',
        '#import "chapters/intro.typ": intro',
        '#set text(font: "Noto Sans")',
        "",
        "= Headless Functional Smoke",
        "",
        "#intro",
        "",
        '#image("figures/shape.svg", width: 20pt)'
      ].join("\n")
    }
  );
  await api("PUT", `/v1/projects/${projectId}/settings`, adminId, {
    entry_file_path: "main.typ"
  });
  await uploadAsset("figures/shape.svg", simpleSvg, "image/svg+xml");
  await uploadAsset("fonts/NotoSans-Regular.ttf", fontBytes, "font/ttf");

  const archiveRes = await fetch(`${coreApi}/v1/projects/${projectId}/archive`, {
    headers: { "x-user-id": adminId }
  });
  if (!archiveRes.ok) {
    throw new Error(`Archive export failed (${archiveRes.status})`);
  }

  await admin.goto(`${baseUrl}/project/${projectId}?dev_user_id=${adminId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await admin.getByRole("heading", { name: "Editor" }).waitFor({ timeout: 20000 });
  await admin.locator(".tree-label", { hasText: "main.typ" }).first().waitFor({ timeout: 20000 });
  await waitForCanvas(admin, 60000);
  const shot1 = path.join(outDir, "01-workspace-load.png");
  await admin.screenshot({ path: shot1, fullPage: true });
  artifacts.push(shot1);

  await admin.locator(".tree-label", { hasText: "main.typ" }).first().click();
  const beforeChecksum = await canvasChecksum(admin);

  await member.goto(`${baseUrl}/project/${projectId}?dev_user_id=${memberId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await member.getByRole("heading", { name: "Editor" }).waitFor({ timeout: 20000 });
  await member.locator(".tree-label", { hasText: "main.typ" }).first().click();

  await admin.locator(".cm-content").click();
  await admin.keyboard.press("End");
  await admin.keyboard.type("\nRealtime update from admin.\n", { delay: 4 });
  await wait(1200);
  const shot2 = path.join(outDir, "02-realtime-edit.png");
  await admin.screenshot({ path: shot2, fullPage: true });
  artifacts.push(shot2);

  const start = Date.now();
  while (Date.now() - start < 15000) {
    const next = await canvasChecksum(admin);
    if (next !== beforeChecksum && next > 0) break;
    await wait(250);
  }
  const afterChecksum = await canvasChecksum(admin);
  if (afterChecksum === beforeChecksum || afterChecksum === 0) {
    throw new Error("Preview did not update after include file realtime edit");
  }

  await admin.getByRole("button", { name: "Show Project Settings" }).click();
  await admin.getByText("Git Access URL").waitFor({ timeout: 10000 });
  await admin.getByRole("button", { name: "Show Revisions" }).click();

  const historyItems = await admin.locator(".history-item").count();
  if (historyItems < 1) {
    throw new Error("Expected at least one automatic revision");
  }
  await admin.locator(".history-item").first().click();
  await admin.getByText("Mode: Revision (read-only)").waitFor({ timeout: 10000 });
  await admin.locator(".history-item").first().click();
  await admin.getByText("Mode: Live").waitFor({ timeout: 10000 });
  const shot3 = path.join(outDir, "03-settings-revisions.png");
  await admin.screenshot({ path: shot3, fullPage: true });
  artifacts.push(shot3);

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        packageProxyOk,
        screenshots: artifacts,
        browserErrors
      },
      null,
      2
    )
  );
} catch (error) {
  const shot = path.join(outDir, "99-failure.png");
  await admin.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
  console.error(
    JSON.stringify(
      {
        ok: false,
        baseUrl,
        screenshots: [...artifacts, shot],
        error: String(error),
        browserErrors
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  await admin.close().catch(() => undefined);
  await member.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
