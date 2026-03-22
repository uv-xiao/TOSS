import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { chromium } from "playwright";

const baseUrl = process.env.WEB_BASE_URL ?? "http://localhost:3000";
const coreApi = process.env.CORE_API_URL ?? "http://127.0.0.1:18080";
const projectId = process.env.PROJECT_ID ?? "00000000-0000-0000-0000-000000000010";
const teacherId = "00000000-0000-0000-0000-000000000100";
const studentId = "00000000-0000-0000-0000-000000000101";
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-collab-git";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString("utf8").trim();
}

async function setEditorText(page, text) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text, { delay: 4 });
}

async function getEditorText(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".cm-content");
    return el?.textContent ?? "";
  });
}

async function waitForEditorContains(page, snippet, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await getEditorText(page);
    if (text.includes(snippet)) return;
    await sleep(150);
  }
  throw new Error(`editor did not contain snippet: ${snippet}`);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const screenshots = [];

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "typst-collab-git-"));
  const remoteBare = path.join(tmpRoot, "remote.git");
  const serverMirror = path.join("/tmp/typst-git", projectId);
  const offline = path.join(tmpRoot, "offline");

  try {
    await fs.access(path.join(serverMirror, ".git"));
    run(`git clone --bare ${serverMirror} ${remoteBare}`);
  } catch {
    const seed = path.join(tmpRoot, "seed");
    run(`git init --bare ${remoteBare}`);
    await fs.mkdir(seed, { recursive: true });
    run("git init -b main", seed);
    run("git config user.name 'Seed User'", seed);
    run("git config user.email 'seed@example.edu'", seed);
    await fs.writeFile(path.join(seed, "main.typ"), "= Headless Git\n\nSeed remote.\n", "utf8");
    run("git add .", seed);
    run("git commit -m 'seed remote'", seed);
    run(`git remote add origin ${remoteBare}`, seed);
    run("git push origin main", seed);
  }

  await api(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
    teacherId,
    { content: "= Headless Collaboration\n\nInitial content.\n" }
  );
  await api("PUT", `/v1/git/config/${projectId}`, teacherId, {
    remote_url: remoteBare,
    default_branch: "main"
  });

  const browser = await chromium.launch({ headless: true });
  const teacher = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const student = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const browserErrors = [];
  for (const p of [teacher, student]) {
    p.on("console", (msg) => {
      if (msg.type() === "error") browserErrors.push(`console:${msg.text()}`);
    });
    p.on("pageerror", (err) => {
      browserErrors.push(`pageerror:${String(err)}`);
    });
  }

  try {
    await teacher.goto(`${baseUrl}/?dev_user_id=${teacherId}`, { waitUntil: "networkidle" });
    await student.goto(`${baseUrl}/?dev_user_id=${studentId}`, { waitUntil: "networkidle" });
    await teacher.getByText("Typst School Collaboration").waitFor({ timeout: 30000 });
    await student.getByText("Typst School Collaboration").waitFor({ timeout: 30000 });

    await setEditorText(teacher, "= Headless Collaboration\n\nTeacher live edit.\n");
    await waitForEditorContains(student, "Teacher live edit.", 12000);
    await student.locator(".cm-content").click();
    await student.keyboard.press("End");
    await student.keyboard.type("\nStudent live edit.\n", { delay: 4 });
    await waitForEditorContains(teacher, "Student live edit.", 12000);

    const collabShot = path.join(outDir, "01-collab.png");
    await teacher.screenshot({ path: collabShot, fullPage: true });
    screenshots.push(collabShot);

    await teacher.getByRole("button", { name: "Pull" }).click();
    await teacher.getByRole("button", { name: /Pull|Pulling\.\.\./ }).waitFor({ timeout: 8000 });
    await teacher.getByRole("button", { name: "Pull" }).waitFor({ timeout: 12000 });
    await teacher.getByRole("button", { name: "Push" }).click();
    await teacher.getByRole("button", { name: /Push|Pushing\.\.\./ }).waitFor({ timeout: 8000 });
    await teacher.getByRole("button", { name: "Push" }).waitFor({ timeout: 12000 });

    await fs.mkdir(offline, { recursive: true });
    run(`git clone ${remoteBare} ${offline}`);
    run("git checkout -B main origin/main", offline);
    run("git config user.name 'Offline User'", offline);
    run("git config user.email 'offline@example.edu'", offline);
    await fs.writeFile(path.join(offline, "notes.typ"), "= Offline Notes\n\nRemote-only change.\n", "utf8");
    run("git add notes.typ", offline);
    run("git commit -m 'offline remote update'", offline);
    run("git push origin main", offline);

    await teacher.locator(".cm-content").click();
    await teacher.keyboard.press("End");
    await teacher.keyboard.type("\nServer-side collaborative update.\n", { delay: 4 });
    await sleep(1500);

    await teacher.getByRole("button", { name: "Push" }).click();
    await teacher.getByText("Git push failed").waitFor({ timeout: 12000 });
    const failedPushShot = path.join(outDir, "02-push-rejected.png");
    await teacher.screenshot({ path: failedPushShot, fullPage: true });
    screenshots.push(failedPushShot);

    await teacher.getByRole("button", { name: "Pull" }).click();
    await teacher.getByRole("button", { name: /Pull|Pulling\.\.\./ }).waitFor({ timeout: 8000 });
    await teacher.getByRole("button", { name: "Pull" }).waitFor({ timeout: 12000 });
    await teacher.getByRole("button", { name: "Push" }).click();
    await teacher.getByRole("button", { name: /Push|Pushing\.\.\./ }).waitFor({ timeout: 8000 });
    await teacher.getByRole("button", { name: "Push" }).waitFor({ timeout: 12000 });
    const pushFailedVisible = await teacher.getByText("Git push failed").isVisible().catch(() => false);
    if (pushFailedVisible) {
      throw new Error("push still failing after pull+push retry");
    }

    const finalShot = path.join(outDir, "03-after-recovery.png");
    await teacher.screenshot({ path: finalShot, fullPage: true });
    screenshots.push(finalShot);

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
