import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? baseUrl;
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-full-journey";
const projectId = process.env.PROJECT_ID ?? "00000000-0000-0000-0000-000000000010";
const teacherId = "00000000-0000-0000-0000-000000000100";
const studentId = "00000000-0000-0000-0000-000000000101";
const fontPath =
  process.env.FONT_FILE_PATH ??
  "/Users/zizhengguo/projects/typst/apps/web/public/typst-fonts/NotoSans-Regular.ttf";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, p, userId, body) {
  const res = await fetch(`${coreApi}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-user-id": userId
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    throw new Error(`${method} ${p} failed (${res.status}): ${await res.text()}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function expectEditorContains(page, text, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = await page.locator(".cm-content").innerText();
    if (content.includes(text)) return;
    await wait(150);
  }
  throw new Error(`Editor missing text: ${text}`);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const screenshots = [];
  const browser = await chromium.launch({ headless: true });
  const teacher = await browser.newPage({ viewport: { width: 1660, height: 1020 } });
  const student = await browser.newPage({ viewport: { width: 1660, height: 1020 } });
  const browserErrors = [];
  for (const p of [teacher, student]) {
    p.on("console", (msg) => {
      if (msg.type() === "error") browserErrors.push(`console:${msg.text()}`);
    });
    p.on("pageerror", (err) => browserErrors.push(`pageerror:${String(err)}`));
  }

  try {
    const suffix = Date.now().toString();
    const dirPath = `chapters/section-a-${suffix}`;
    const notesPath = `${dirPath}/notes.typ`;
    const renamedNotesPath = `${dirPath}/renamed-notes.typ`;

    await api(
      "PUT",
      `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
      teacherId,
      { content: "= Journey Root\n\nHello from main.\n" }
    );
    await api("POST", `/v1/projects/${projectId}/files`, teacherId, {
      path: "chapters",
      kind: "directory"
    });
    await api("POST", `/v1/projects/${projectId}/files`, teacherId, {
      path: "chapters/intro.typ",
      kind: "file",
      content: "= Intro\n\nSeed intro.\n"
    });

    await teacher.goto(`${baseUrl}/projects?dev_user_id=${teacherId}`, { waitUntil: "networkidle" });
    await teacher.getByRole("heading", { name: "Projects" }).waitFor({ timeout: 15000 });
    const shot1 = path.join(outDir, "01-projects.png");
    await teacher.screenshot({ path: shot1, fullPage: true });
    screenshots.push(shot1);

    await teacher.goto(`${baseUrl}/project/${projectId}?dev_user_id=${teacherId}`, {
      waitUntil: "networkidle"
    });
    await teacher.getByRole("heading", { name: "Editor" }).waitFor({ timeout: 20000 });
    await teacher.locator(".tree-label", { hasText: "chapters/intro.typ" }).click();
    await expectEditorContains(teacher, "Seed intro.");
    const shot2 = path.join(outDir, "02-workspace-initial.png");
    await teacher.screenshot({ path: shot2, fullPage: true });
    screenshots.push(shot2);

    teacher.once("dialog", async (dialog) => dialog.accept(dirPath));
    await teacher.getByRole("button", { name: "New Dir" }).click();
    teacher.once("dialog", async (dialog) => dialog.accept(notesPath));
    await teacher.getByRole("button", { name: "New File" }).click();
    await teacher.locator(".tree-label", { hasText: notesPath }).click();
    await teacher.locator(".cm-content").click();
    await teacher.keyboard.press("Control+A");
    await teacher.keyboard.type("= Section A\n\nRealtime editable file.\n", { delay: 3 });
    await wait(1200);

    teacher.once("dialog", async (dialog) => dialog.accept(renamedNotesPath));
    await teacher
      .locator(".tree-node", { hasText: notesPath })
      .getByRole("button", { name: "Rename" })
      .click();
    await wait(600);
    const shot3 = path.join(outDir, "03-tree-crud-rename.png");
    await teacher.screenshot({ path: shot3, fullPage: true });
    screenshots.push(shot3);

    teacher.once("dialog", async (dialog) => dialog.accept("chapters/intro.typ"));
    await teacher.getByRole("button", { name: "Set Entry File" }).click();
    await teacher.getByPlaceholder("Revision summary").fill("Journey revision");
    await teacher.getByRole("button", { name: "Add Revision" }).click();

    const fileChooserPromise = teacher.waitForEvent("filechooser");
    await teacher.getByRole("button", { name: "Upload Font" }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles(fontPath);
    await wait(1200);
    const shot4 = path.join(outDir, "04-entry-revision-font.png");
    await teacher.screenshot({ path: shot4, fullPage: true });
    screenshots.push(shot4);

    const archiveResp = await fetch(`${baseUrl}/v1/projects/${projectId}/archive`, {
      headers: {
        "x-user-id": teacherId
      }
    });
    if (!archiveResp.ok) {
      throw new Error(`Archive download failed: ${archiveResp.status}`);
    }
    await teacher.getByRole("button", { name: "Download PDF (Client)" }).click();
    const popupPromise = teacher.waitForEvent("popup");
    await teacher.getByRole("button", { name: "Save PDF Artifact" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    const popupUrl = popup.url();
    await popup.close();
    if (!popupUrl.includes("/pdf-artifacts/latest")) {
      throw new Error(`Unexpected PDF artifact popup URL: ${popupUrl}`);
    }
    const shot5 = path.join(outDir, "05-downloads-git-panel.png");
    await teacher.screenshot({ path: shot5, fullPage: true });
    screenshots.push(shot5);

    await teacher.goto(`${baseUrl}/profile?dev_user_id=${teacherId}`, { waitUntil: "networkidle" });
    await teacher.getByRole("heading", { name: "Profile Security" }).waitFor({ timeout: 12000 });
    await teacher.getByRole("button", { name: "Create Token" }).click();
    await teacher.getByText("New token shown once").waitFor({ timeout: 12000 });
    const shot6 = path.join(outDir, "06-profile-token.png");
    await teacher.screenshot({ path: shot6, fullPage: true });
    screenshots.push(shot6);

    await teacher.goto(`${baseUrl}/admin?dev_user_id=${teacherId}`, { waitUntil: "networkidle" });
    await teacher.getByRole("heading", { name: "Admin: OIDC Group Role Mapping" }).waitFor({
      timeout: 12000
    });
    await teacher.getByPlaceholder("OIDC group value").fill("course:typst-2026");
    await teacher.getByRole("button", { name: "Save" }).click();
    await teacher.getByText("course:typst-2026").waitFor({ timeout: 12000 });
    await teacher
      .locator(".card", { hasText: "course:typst-2026" })
      .getByRole("button", { name: "Remove" })
      .click();
    const shot7 = path.join(outDir, "07-admin-mapping.png");
    await teacher.screenshot({ path: shot7, fullPage: true });
    screenshots.push(shot7);

    await teacher.goto(`${baseUrl}/project/${projectId}?dev_user_id=${teacherId}`, {
      waitUntil: "networkidle"
    });
    await student.goto(`${baseUrl}/project/${projectId}?dev_user_id=${studentId}`, {
      waitUntil: "networkidle"
    });
    await teacher.locator(".tree-label", { hasText: "main.typ" }).click();
    await student.locator(".tree-label", { hasText: "main.typ" }).click();
    await teacher.locator(".cm-content").click();
    await teacher.keyboard.press("Control+A");
    await teacher.keyboard.type("= Live Sync\n\nTeacher edit appears on student.\n", { delay: 3 });
    await expectEditorContains(student, "Teacher edit appears on student.");
    await student.locator(".cm-content").click();
    await student.keyboard.press("End");
    await student.keyboard.type("\nStudent confirms sync.\n", { delay: 3 });
    await expectEditorContains(teacher, "Student confirms sync.");

    const shot8 = path.join(outDir, "08-realtime-collab.png");
    await teacher.screenshot({ path: shot8, fullPage: true });
    screenshots.push(shot8);

    console.log(
      JSON.stringify(
        {
          ok: true,
          screenshots,
          browserErrors
        },
        null,
        2
      )
    );
  } catch (error) {
    const failShot = path.join(outDir, "99-failure.png");
    await teacher.screenshot({ path: failShot, fullPage: true }).catch(() => undefined);
    screenshots.push(failShot);
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: String(error),
          screenshots,
          browserErrors
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    await teacher.close().catch(() => undefined);
    await student.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main();
