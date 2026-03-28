import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? baseUrl;
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-headless";
const runId = Date.now().toString();
const ownerEmail = `owner-${runId}@example.com`;
const ownerPassword = "Owner1234!";
const collaboratorEmail = `collab-${runId}@example.com`;
const collaboratorPassword = "Collab1234!";
const contextCreatedName = `from-context-${runId}.typ`;
const contextCreatedPath = `chapters/${contextCreatedName}`;
const contextRenamedName = `renamed-${runId}.typ`;
const contextRenamedPath = `chapters/${contextRenamedName}`;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fontPath = process.env.FONT_FILE_PATH ?? "";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function parseJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON (${res.status}): ${text}`);
  }
}

async function bearerApi(method, route, token, body) {
  const res = await fetch(`${coreApi}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await parseJson(res);
  if (!res.ok) {
    throw new Error(`${method} ${route} failed (${res.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function registerOrLogin(email, password, displayName) {
  const emailPrefix = email.split("@")[0] || "user";
  const username = emailPrefix.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32) || `user${Date.now()}`;
  const registerRes = await fetch(`${coreApi}/v1/auth/local/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      username,
      display_name: displayName
    })
  });
  if (registerRes.ok) {
    const payload = await parseJson(registerRes);
    return {
      email,
      password,
      userId: payload.user_id,
      sessionToken: payload.session_token
    };
  }

  if (registerRes.status !== 403 && registerRes.status !== 409) {
    const payload = await parseJson(registerRes);
    throw new Error(`register ${email} failed (${registerRes.status}): ${JSON.stringify(payload)}`);
  }

  const loginRes = await fetch(`${coreApi}/v1/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const payload = await parseJson(loginRes);
  if (!loginRes.ok) {
    throw new Error(`login ${email} failed (${loginRes.status}): ${JSON.stringify(payload)}`);
  }
  return {
    email,
    password,
    userId: payload.user_id,
    sessionToken: payload.session_token
  };
}

async function login(page, email, password) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 30000 });
}

async function openWorkspace(page, projectId) {
  await page.goto(`${baseUrl}/project/${projectId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  await page.locator(".panel-editor .panel-header h2").first().waitFor({ timeout: 30000 });
  await page.locator(".tree-label", { hasText: "main.typ" }).first().waitFor({ timeout: 30000 });
}

async function waitForActiveFile(page, filePath, timeoutMs = 10000) {
  await page.waitForFunction(
    (path) => {
      const headerTitle = document.querySelector(".panel-editor .panel-header h2");
      if (!headerTitle) return false;
      const title = headerTitle.getAttribute("title") || "";
      const text = headerTitle.textContent || "";
      return title === path || text.includes(path.split("/").filter(Boolean).pop() || path);
    },
    filePath,
    { timeout: timeoutMs }
  );
}

async function canvasChecksum(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".pdf-frame canvas");
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (!ctx) return 0;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 2048) {
        sum = (sum * 31 + data[i] + data[i + 1] + data[i + 2]) >>> 0;
      }
      return sum;
    }
    const pageNode = document.querySelector(".pdf-frame .typst-page");
    if (!pageNode) return 0;
    const raw = pageNode.outerHTML;
    let hash = 0;
    for (let i = 0; i < raw.length; i += 1) {
      hash = (hash * 33 + raw.charCodeAt(i)) >>> 0;
    }
    return hash;
  });
}

async function waitForCanvas(page, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await page.locator(".pdf-frame canvas, .pdf-frame .typst-page").count()) > 0) return;
    await wait(300);
  }
  const errors = await page.locator(".error").allInnerTexts();
  throw new Error(`Preview not rendered. Errors: ${errors.join(" | ")}`);
}

async function assertVisiblePreviewPage(page) {
  const metrics = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(".pdf-frame .typst-page, .pdf-frame canvas"));
    const sizes = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    const maxWidth = sizes.reduce((m, s) => Math.max(m, s.width), 0);
    const maxHeight = sizes.reduce((m, s) => Math.max(m, s.height), 0);
    const zoomText = document.querySelector(".zoom-indicator")?.textContent?.trim() || "";
    return { count: nodes.length, maxWidth, maxHeight, zoomText };
  });
  if (metrics.count < 1 || metrics.maxWidth < 120 || metrics.maxHeight < 120) {
    throw new Error(
      `Preview page looks collapsed (count=${metrics.count}, maxWidth=${metrics.maxWidth}, maxHeight=${metrics.maxHeight}, zoom=${metrics.zoomText})`
    );
  }
}

async function assertWorkspaceLayout(page) {
  const metrics = await page.evaluate(() => {
    const stage = document.querySelector(".workspace-stage")?.getBoundingClientRect();
    const shell = document.querySelector(".workspace-shell")?.getBoundingClientRect();
    const app = document.querySelector(".app-shell")?.getBoundingClientRect();
    const topbar = document.querySelector(".topbar")?.getBoundingClientRect();
    const editorContent = document.querySelector(".panel-editor .panel-content");
    const previewContent = document.querySelector(".panel-preview .panel-content")?.getBoundingClientRect();
    const previewFrame = document.querySelector(".pdf-frame")?.getBoundingClientRect();
    const toggles = document.querySelectorAll(".workspace-icon-toggles .icon-toggle").length;
    const rootHeight = document.documentElement.clientHeight;
    return {
      stageBottomGap: stage ? Math.max(0, rootHeight - stage.bottom) : 999,
      stageTop: stage?.top ?? -1,
      stageHeight: stage?.height ?? -1,
      shellBottomGap: shell ? Math.max(0, rootHeight - shell.bottom) : 999,
      shellHeight: shell?.height ?? -1,
      appHeight: app?.height ?? -1,
      appBottomGap: app ? Math.max(0, rootHeight - app.bottom) : 999,
      topbarHeight: topbar?.height ?? -1,
      editorPadding: editorContent ? getComputedStyle(editorContent).padding : "missing",
      previewHeightDelta:
        previewContent && previewFrame ? Math.abs(previewContent.height - previewFrame.height) : 999,
      toggles
    };
  });
  if (metrics.toggles < 4) throw new Error("panel icon toggles are missing");
  if (metrics.editorPadding !== "0px") throw new Error(`editor panel has unexpected padding: ${metrics.editorPadding}`);
  if (metrics.previewHeightDelta > 4) {
    throw new Error(`preview frame does not fill panel content (delta=${metrics.previewHeightDelta})`);
  }
  if (metrics.stageBottomGap > 20) {
    throw new Error(
      `workspace leaves large bottom gap (${metrics.stageBottomGap}px, stageTop=${metrics.stageTop}, stageHeight=${metrics.stageHeight}, shellHeight=${metrics.shellHeight}, shellGap=${metrics.shellBottomGap}, appHeight=${metrics.appHeight}, appGap=${metrics.appBottomGap}, topbar=${metrics.topbarHeight})`
    );
  }
}

async function acceptPrompt(page, trigger, value) {
  let seenPrompt = false;
  page.once("dialog", async (dialog) => {
    if (dialog.type() !== "prompt") throw new Error(`Expected prompt, got ${dialog.type()}`);
    seenPrompt = true;
    await dialog.accept(value);
  });
  await trigger();
  await wait(200);
  if (seenPrompt) return;
  const dialog = page
    .locator(".ui-dialog")
    .filter({ has: page.locator("input, textarea") })
    .last();
  if ((await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false))) {
    const modalInput = dialog.locator("input, textarea").first();
    await modalInput.waitFor({ timeout: 5000 });
    await modalInput.fill(value);
    let saveButton = dialog.getByRole("button", {
      name: /(Save|Create|OK|Confirm|确认|保存|创建|确定)/i
    });
    if ((await saveButton.count()) === 0) {
      saveButton = dialog.locator("button");
    }
    if ((await saveButton.count()) > 0) {
      await saveButton.last().click();
      return;
    }
  }
  throw new Error("Expected prompt dialog/modal was not shown");
}

async function acceptConfirm(page, trigger, accept = true) {
  let seenConfirm = false;
  page.once("dialog", async (dialog) => {
    if (dialog.type() !== "confirm") throw new Error(`Expected confirm, got ${dialog.type()}`);
    seenConfirm = true;
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await trigger();
  await wait(200);
  if (seenConfirm) return;
  const dialog = page.locator(".ui-dialog").last();
  if ((await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false))) {
    const actionPattern = accept
      ? /(Delete|Confirm|OK|Revoke|确认|删除|撤销|确定)/i
      : /(Cancel|No|取消)/i;
    const actionButton = dialog.getByRole("button", { name: actionPattern }).last();
    if ((await actionButton.count()) > 0) {
      await actionButton.click();
      return;
    }
  }
  const actionPattern = accept
    ? /^(Delete|Confirm|OK|Revoke|确认|删除|撤销)$/i
    : /^(Cancel|No|取消)$/i;
  const actionButton = page.locator("button", { hasText: actionPattern }).first();
  if ((await actionButton.count()) > 0 && (await actionButton.isVisible().catch(() => false))) {
    await actionButton.click();
    return;
  }
  throw new Error("Expected confirm dialog/modal was not shown");
}

function treeNode(page, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page
    .locator(".tree-node", {
      has: page.locator(".tree-label", { hasText: new RegExp(`^\\s*${escaped}\\s*$`) })
    })
    .first();
}

function contextMenuAction(page, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page
    .locator(".context-menu-floating:visible")
    .last()
    .getByRole("button", { name: new RegExp(`^\\s*${escaped}\\s*$`) })
    .first();
}

async function ensureDirectoryExpanded(page, name) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const row = treeNode(page, name);
    await row.waitFor({ timeout: 4000 });
    const toggle = row.locator(".tree-toggle").first();
    const symbol = (await toggle.textContent())?.trim();
    if (symbol === "▾") return;
    if (symbol === "▸") {
      await row.locator(".tree-label").first().click();
      await wait(120);
      continue;
    }
    await wait(100);
  }
  throw new Error(`directory did not expand: ${name}`);
}

async function editorText(page) {
  return page.locator(".cm-content").innerText();
}

async function waitForEditorContains(page, snippet, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await editorText(page)).includes(snippet)) return;
    await wait(150);
  }
  throw new Error(`editor missing snippet: ${snippet}`);
}

async function openContextMenu(page, name, method = "button") {
  const row = treeNode(page, name);
  if (method === "right") await row.click({ button: "right" });
  else await row.locator("button.mini").first().click();
  await page.locator(".context-menu-floating").first().waitFor({ timeout: 10000 });
}

async function dragHandleX(page, handle, deltaX, label = "handle") {
  const box = await handle.boundingBox();
  if (!box) throw new Error(`missing draggable handle: ${label}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 10 });
  await page.mouse.up();
}

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const contextA = await browser.newContext({
  viewport: { width: 1620, height: 1020 },
  locale: "en-US"
});
const contextB = await browser.newContext({
  viewport: { width: 1620, height: 1020 },
  locale: "en-US"
});
await contextA.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
const pageA = await contextA.newPage();
const pageB = await contextB.newPage();
const browserErrors = [];
for (const page of [pageA, pageB]) {
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" && !text.includes("401 (Unauthorized)")) {
      browserErrors.push(`console:${text}`);
    }
  });
  page.on("pageerror", (err) => {
    browserErrors.push(`pageerror:${String(err)}`);
  });
}

const artifacts = [];
let currentStep = "init";

try {
  const owner = await registerOrLogin(ownerEmail, ownerPassword, "Owner");
  const collaborator = await registerOrLogin(collaboratorEmail, collaboratorPassword, "Collaborator");
  const project = await bearerApi("POST", "/v1/projects", owner.sessionToken, {
    organization_id: "00000000-0000-0000-0000-000000000001",
    name: `Smoke Project ${runId}`,
    description: "Headless smoke test project"
  });
  const projectId = project.id;
  await bearerApi("POST", `/v1/projects/${projectId}/roles`, owner.sessionToken, {
    user_id: collaborator.userId,
    role: "Student"
  });

  let optionalFontBytes = null;
  if (fontPath) {
    try {
      optionalFontBytes = new Uint8Array(await fs.readFile(fontPath));
    } catch {
      optionalFontBytes = null;
    }
  }
  const simpleSvg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#2f7d4a"/></svg>'
  );
  const rawBinary = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 255, 254, 253, 252]);
  const tempUploadFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "typst-upload-")), "upload.typ");
  await fs.writeFile(tempUploadFile, "= Uploaded From UI\n\nThis file came from file chooser.\n", "utf8");

  await bearerApi("POST", `/v1/projects/${projectId}/files`, owner.sessionToken, {
    path: "chapters",
    kind: "directory"
  });
  await bearerApi("POST", `/v1/projects/${projectId}/files`, owner.sessionToken, {
    path: "figures",
    kind: "directory"
  });
  await bearerApi("POST", `/v1/projects/${projectId}/files`, owner.sessionToken, {
    path: "fonts",
    kind: "directory"
  });
  await bearerApi(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("chapters/intro.typ")}`,
    owner.sessionToken,
    { content: "#let intro = [Realtime include content.]" }
  );
  await bearerApi(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
    owner.sessionToken,
    {
      content: [
        '#import "@preview/cetz:0.4.2": *',
        '#import "chapters/intro.typ": intro',
        '#set text(font: "Libertinus Serif")',
        "",
        "= Headless Functional Smoke",
        "",
        "#intro",
        "",
        '#image("figures/shape.svg", width: 20pt)'
      ].join("\n")
    }
  );
  await bearerApi("PUT", `/v1/projects/${projectId}/settings`, owner.sessionToken, {
    entry_file_path: "main.typ"
  });
  await bearerApi("POST", `/v1/projects/${projectId}/assets`, owner.sessionToken, {
    path: "figures/shape.svg",
    content_base64: Buffer.from(simpleSvg).toString("base64"),
    content_type: "image/svg+xml"
  });
  if (optionalFontBytes) {
    await bearerApi("POST", `/v1/projects/${projectId}/assets`, owner.sessionToken, {
      path: "fonts/Custom.ttf",
      content_base64: Buffer.from(optionalFontBytes).toString("base64"),
      content_type: "font/ttf"
    });
  }
  await bearerApi("POST", `/v1/projects/${projectId}/assets`, owner.sessionToken, {
    path: "blob.bin",
    content_base64: Buffer.from(rawBinary).toString("base64"),
    content_type: "application/octet-stream"
  });

  await login(pageA, owner.email, owner.password);
  currentStep = "login-owner";
  await login(pageB, collaborator.email, collaborator.password);
  currentStep = "login-collaborator";
  await openWorkspace(pageA, projectId);
  currentStep = "open-workspace-owner";
  await openWorkspace(pageB, projectId);
  currentStep = "open-workspace-collab";
  await waitForActiveFile(pageA, "main.typ", 15000);
  await waitForActiveFile(pageB, "main.typ", 15000);
  await waitForCanvas(pageA, 60000);
  await assertVisiblePreviewPage(pageA);
  await assertWorkspaceLayout(pageA);

  const shot1 = path.join(outDir, "01-workspace-load.png");
  await pageA.screenshot({ path: shot1, fullPage: true });
  artifacts.push(shot1);

  const widthsBefore = await pageA.evaluate(() => {
    const files = document.querySelector(".panel-files")?.getBoundingClientRect().width ?? 0;
    const editor = document.querySelector(".panel-editor")?.getBoundingClientRect().width ?? 0;
    const preview = document.querySelector(".panel-preview")?.getBoundingClientRect().width ?? 0;
    return { files, editor, preview };
  });
  if ((await pageA.locator(".panel-preview").count()) === 0) {
    await pageA.getByRole("button", { name: "Preview" }).click();
  }
  if ((await pageA.locator(".panel-files").count()) === 0) {
    await pageA.getByRole("button", { name: "Files" }).click();
  }
  const filesHandle = pageA.locator(".workspace-stage > .panel-resizer").first();
  const splitHandle = pageA.locator(".center-split > .panel-resizer").first();
  await dragHandleX(pageA, filesHandle, 64, "files resizer");
  await dragHandleX(pageA, splitHandle, -96, "editor-preview resizer");
  await wait(220);
  const widthsAfterDrag = await pageA.evaluate(() => {
    const files = document.querySelector(".panel-files")?.getBoundingClientRect().width ?? 0;
    const editor = document.querySelector(".panel-editor")?.getBoundingClientRect().width ?? 0;
    const preview = document.querySelector(".panel-preview")?.getBoundingClientRect().width ?? 0;
    return { files, editor, preview };
  });
  if (widthsAfterDrag.files < widthsBefore.files + 28) {
    throw new Error("files panel resize did not apply");
  }
  if (widthsAfterDrag.editor > widthsBefore.editor - 40) {
    throw new Error("editor/preview split resize did not apply");
  }

  await pageA.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await pageA.locator(".panel-editor .panel-header h2").first().waitFor({ timeout: 30000 });
  const widthsAfterReload = await pageA.evaluate(() => {
    const files = document.querySelector(".panel-files")?.getBoundingClientRect().width ?? 0;
    const editor = document.querySelector(".panel-editor")?.getBoundingClientRect().width ?? 0;
    return { files, editor };
  });
  if (Math.abs(widthsAfterReload.files - widthsAfterDrag.files) > 6) {
    throw new Error("files panel width was not persisted");
  }

  const beforeChecksum = await canvasChecksum(pageA);
  currentStep = "realtime-edit";
  await pageA.locator(".cm-content").click();
  await pageA.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
  await pageA.keyboard.type("Realtime update from owner.\n", { delay: 4 });
  await waitForEditorContains(pageB, "Realtime update from owner.");
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const next = await canvasChecksum(pageA);
    if (next !== beforeChecksum && next > 0) break;
    await wait(200);
  }
  const afterChecksum = await canvasChecksum(pageA);
  if (afterChecksum === beforeChecksum || afterChecksum === 0) {
    throw new Error("Preview did not update after realtime edit");
  }

  await openContextMenu(pageA, "chapters", "right");
  currentStep = "context-new-file";
  await acceptPrompt(
    pageA,
    () => contextMenuAction(pageA, "New File").click(),
    contextCreatedName
  );
  currentStep = "verify-created-file";
  await ensureDirectoryExpanded(pageA, "chapters");
  let contextCreatedActualName = contextCreatedName;
  const createdPrimary = pageA.locator(".tree-label", { hasText: contextCreatedName }).first();
  if ((await createdPrimary.count()) > 0 && (await createdPrimary.isVisible().catch(() => false))) {
    contextCreatedActualName = contextCreatedName;
  } else {
    const createdFallback = pageA.locator(".tree-label", { hasText: "untitled.typ" }).first();
    await createdFallback.waitFor({ timeout: 20000 });
    contextCreatedActualName = "untitled.typ";
  }
  await pageA.locator(".tree-label", { hasText: contextCreatedActualName }).first().click();
  await waitForActiveFile(pageA, contextCreatedActualName, 10000);

  try {
    await openContextMenu(pageA, contextCreatedActualName, "right");
    currentStep = "context-rename-file";
    await acceptPrompt(
      pageA,
      () => contextMenuAction(pageA, "Rename").click(),
      contextRenamedName
    );
    await waitForActiveFile(pageA, contextRenamedName, 10000);
    currentStep = "verify-renamed-file";
    await pageA
      .locator(".tree-label", { hasText: path.basename(contextRenamedPath) })
      .first()
      .waitFor({ timeout: 10000 });
  } catch (err) {
    browserErrors.push(`rename-step:${String(err)}`);
    const createdLabel = pageA.locator(".tree-label", { hasText: contextCreatedActualName }).first();
    if ((await createdLabel.count()) > 0 && (await createdLabel.isVisible().catch(() => false))) {
      await createdLabel.click();
    } else {
      const renamedLabel = pageA.locator(".tree-label", { hasText: contextRenamedName }).first();
      if ((await renamedLabel.count()) > 0 && (await renamedLabel.isVisible().catch(() => false))) {
        await renamedLabel.click();
      }
    }
  }

  const fileChooserPromise = pageA.waitForEvent("filechooser");
  currentStep = "upload-file";
  await pageA.getByRole("button", { name: "Upload" }).first().click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles(tempUploadFile);
  const uploadedFileName = path.basename(tempUploadFile);
  await pageA
    .locator(".tree-label", { hasText: uploadedFileName })
    .first()
    .waitFor({ timeout: 10000 });
  await pageA.locator(".tree-label", { hasText: uploadedFileName }).first().click();
  await pageA.getByText("Uploaded From UI").waitFor({ timeout: 10000 });

  await openContextMenu(pageA, uploadedFileName);
  currentStep = "context-delete-uploaded-file";
  await acceptConfirm(
    pageA,
    () => contextMenuAction(pageA, "Delete").click()
  );
  await pageA
    .locator(".tree-label", { hasText: uploadedFileName })
    .first()
    .waitFor({ state: "hidden", timeout: 10000 });

  await ensureDirectoryExpanded(pageA, "figures");
  await pageA.locator(".tree-label", { hasText: "shape.svg" }).first().click();
  currentStep = "svg-file-preview";
  await pageA.locator(".file-preview-image").first().waitFor({ timeout: 10000 });
  const svgShowsLoading = await pageA.evaluate(() => {
    const metaSmall = document.querySelector(".file-preview .file-preview-meta small");
    const text = (metaSmall?.textContent || "").toLowerCase();
    return text.includes("loading") || text.includes("加载");
  });
  if (svgShowsLoading) {
    throw new Error("SVG preview still reports loading state after file selection");
  }

  await pageA.locator(".tree-label", { hasText: "blob.bin" }).first().click();
  currentStep = "unsupported-file-preview";
  await pageA.getByText("This file is not editable in web editor. Edit offline and sync with Git.").waitFor({
    timeout: 10000
  });
  if ((await pageA.locator(".file-icon").count()) < 1) {
    throw new Error("unknown file icon is not visible for unsupported file types");
  }

  const archiveDownloadPromise = pageA.waitForEvent("download");
  currentStep = "download-archive";
  await pageA.getByRole("button", { name: "Download ZIP" }).click();
  const archiveDownload = await archiveDownloadPromise;
  const archivePath = path.join(outDir, "archive.zip");
  await archiveDownload.saveAs(archivePath);
  const archiveStat = await fs.stat(archivePath);
  if (archiveStat.size < 100) {
    throw new Error("Archive download is unexpectedly small");
  }

  await pageA.getByRole("button", { name: "Settings" }).click();
  currentStep = "open-settings";
  await pageA.getByText("Git access").waitFor({ timeout: 10000 });
  const settingsPanelInfo = await pageA.evaluate(() => {
    const panel = document.querySelector(".panel-settings .panel-content");
    const entrySelect = document.querySelector(".panel-settings select");
    if (!panel || !entrySelect) {
      return {
        ok: false,
        hasPanel: !!panel,
        hasEntrySelect: !!entrySelect
      };
    }
    const overflowY = getComputedStyle(panel).overflowY;
    const optionCount = entrySelect.querySelectorAll("option").length;
    return { ok: true, overflowY, optionCount };
  });
  if (!settingsPanelInfo.ok) {
    throw new Error(
      `settings panel controls missing (panel=${settingsPanelInfo.hasPanel}, entrySelect=${settingsPanelInfo.hasEntrySelect})`
    );
  }
  if (!["auto", "scroll"].includes(settingsPanelInfo.overflowY)) {
    throw new Error(`settings panel is not vertically scrollable (overflowY=${settingsPanelInfo.overflowY})`);
  }
  if (settingsPanelInfo.optionCount < 1) {
    throw new Error("entry file select has no options");
  }
  const copyButtonBefore = pageA.getByRole("button", { name: "Copy" }).first();
  await copyButtonBefore.click();
  await pageA.getByRole("button", { name: "Copied" }).first().waitFor({ timeout: 3000 });
  await bearerApi("POST", `/v1/projects/${projectId}/revisions`, owner.sessionToken, {
    summary: "Headless UI checkpoint"
  });
  await pageA.getByRole("button", { name: "Revisions" }).click();
  currentStep = "open-revisions";
  let historyCount = 0;
  for (let i = 0; i < 25; i += 1) {
    historyCount = await pageA.locator(".history-item").count();
    if (historyCount > 0) break;
    await wait(200);
  }
  if (historyCount < 1) {
    await openWorkspace(pageA, projectId);
    await pageA.getByRole("button", { name: "Revisions" }).click();
    for (let i = 0; i < 25; i += 1) {
      historyCount = await pageA.locator(".history-item").count();
      if (historyCount > 0) break;
      await wait(200);
    }
  }
  if (historyCount < 1) throw new Error("No revisions available");
  await pageA.locator(".history-item").first().click();
  await pageA.waitForFunction(
    () => {
      const selected = document.querySelector(
        ".history-item.active, .history-item.selected, .history-item[aria-selected='true']"
      );
      return !!selected;
    },
    undefined,
    { timeout: 10000 }
  );
  await pageA.getByRole("button", { name: "Revisions" }).click();
  await waitForCanvas(pageA, 20000);
  await assertVisiblePreviewPage(pageA);

  const shot2 = path.join(outDir, "02-realtime-and-fileops.png");
  await pageA.screenshot({ path: shot2, fullPage: true });
  artifacts.push(shot2);

  await pageA.getByRole("button", { name: "Logout" }).click();
  await pageA.getByPlaceholder("Email").waitFor({ timeout: 10000 });

  const shot3 = path.join(outDir, "03-logout.png");
  await pageA.screenshot({ path: shot3, fullPage: true });
  artifacts.push(shot3);

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        projectId,
        screenshots: artifacts,
        browserErrors
      },
      null,
      2
    )
  );
} catch (error) {
  const shot = path.join(outDir, "99-failure.png");
  await pageA.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
  console.error(
    JSON.stringify(
      {
        ok: false,
        baseUrl,
        screenshots: [...artifacts, shot],
        step: currentStep,
        error: String(error),
        stack: error?.stack,
        browserErrors
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  await pageA.close().catch(() => undefined);
  await pageB.close().catch(() => undefined);
  await contextA.close().catch(() => undefined);
  await contextB.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
