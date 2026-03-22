import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { chromium } from "playwright";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:18080";
const coreApi = process.env.CORE_API_URL ?? "http://127.0.0.1:18080";
const projectId = process.env.PROJECT_ID ?? "00000000-0000-0000-0000-000000000010";
const teacherId = "00000000-0000-0000-0000-000000000100";
const studentId = "00000000-0000-0000-0000-000000000101";
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-collab-git";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: "pipe" }).toString("utf8").trim();
}

async function api(method, p, userId, body) {
  const res = await fetch(`${coreApi}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-user-id": userId
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${p} failed (${res.status}): ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

async function setEditorText(page, text) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text, { delay: 4 });
}

async function editorText(page) {
  return page.locator(".cm-content").innerText();
}

async function waitForEditorContains(page, snippet, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await editorText(page)).includes(snippet)) return;
    await sleep(150);
  }
  throw new Error(`editor missing snippet: ${snippet}`);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const screenshots = [];
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "typst-collab-git-"));
  const offline = path.join(tmpRoot, "offline");
  const stale = path.join(tmpRoot, "stale");

  await api(
    "PUT",
    `/v1/projects/${projectId}/documents/by-path/${encodeURIComponent("main.typ")}`,
    teacherId,
    { content: "= Headless Collaboration\n\nInitial content.\n" }
  );

  const teacherPat = await api("POST", "/v1/profile/security/tokens", teacherId, {
    label: "headless-teacher"
  });
  const repoUrl = `${coreApi.replace(/\/$/, "")}/v1/git/repo/${projectId}`;
  const authRepoUrl = repoUrl.replace("http://", `http://qa:${teacherPat.token}@`);

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
    await teacher.goto(`${baseUrl}/project/${projectId}?dev_user_id=${teacherId}`, {
      waitUntil: "networkidle",
      timeout: 60000
    });
    await student.goto(`${baseUrl}/project/${projectId}?dev_user_id=${studentId}`, {
      waitUntil: "networkidle",
      timeout: 60000
    });
    await teacher.getByRole("heading", { name: "Editor" }).waitFor({ timeout: 30000 });
    await student.getByRole("heading", { name: "Editor" }).waitFor({ timeout: 30000 });

    await setEditorText(teacher, "= Headless Collaboration\n\nTeacher live edit.\n");
    await waitForEditorContains(student, "Teacher live edit.");
    await student.locator(".cm-content").click();
    await student.keyboard.press("End");
    await student.keyboard.type("\nStudent live edit.\n", { delay: 4 });
    await waitForEditorContains(teacher, "Student live edit.");
    await sleep(1200);

    const collabShot = path.join(outDir, "01-collab.png");
    await teacher.screenshot({ path: collabShot, fullPage: true });
    screenshots.push(collabShot);

    await fs.mkdir(offline, { recursive: true });
    await fs.mkdir(stale, { recursive: true });
    run(`git clone ${authRepoUrl} ${offline}`);
    run(`git clone ${authRepoUrl} ${stale}`);
    for (const repo of [offline, stale]) {
      run("git checkout -B main origin/main", repo);
      run("git config user.name 'Offline User'", repo);
      run("git config user.email 'offline@example.edu'", repo);
    }

    const stamp = Date.now().toString();
    await fs.writeFile(path.join(offline, "notes.typ"), `= Offline Notes\n\nRemote update ${stamp}.\n`, "utf8");
    run("git add notes.typ", offline);
    run("git commit -m 'offline remote update'", offline);
    run("git push origin HEAD:main", offline);

    await teacher.locator(".cm-content").click();
    await teacher.keyboard.press("End");
    await teacher.keyboard.type("\nServer-side collaborative update.\n", { delay: 4 });
    await sleep(1500);

    await fs.writeFile(path.join(stale, "main.typ"), "= Stale Push\n\nThis should conflict.\n", "utf8");
    run("git add main.typ", stale);
    run("git commit -m 'stale local update'", stale);
    let staleRejected = false;
    try {
      run("git push origin HEAD:main", stale);
    } catch {
      staleRejected = true;
    }
    if (!staleRejected) {
      throw new Error("stale push unexpectedly succeeded");
    }

    const rejectedShot = path.join(outDir, "02-stale-rejected.png");
    await teacher.screenshot({ path: rejectedShot, fullPage: true });
    screenshots.push(rejectedShot);

    let recovered = false;
    try {
      run("git pull --rebase origin main", stale);
      recovered = true;
    } catch {
      run("git rebase --abort || true", stale);
      try {
        run("git pull --no-rebase origin main", stale);
        recovered = true;
      } catch {
        const merged = run("git show origin/main:main.typ", stale);
        await fs.writeFile(path.join(stale, "main.typ"), `${merged}\nStale merge recovery.\n`, "utf8");
        run("git add main.typ", stale);
        run("git commit -m 'Resolve stale merge conflict'", stale);
        recovered = true;
      }
    }
    if (!recovered) {
      throw new Error("unable to recover stale branch");
    }
    run("git push origin HEAD:main", stale);

    run("git reset --hard HEAD~1", stale);
    let forceRejected = false;
    try {
      run("git push --force origin HEAD:main", stale);
    } catch {
      forceRejected = true;
    }
    if (!forceRejected) {
      throw new Error("force push unexpectedly succeeded");
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
