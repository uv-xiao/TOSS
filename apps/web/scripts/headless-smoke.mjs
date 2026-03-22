import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:3000";
const outDir = process.env.SCREENSHOT_DIR ?? "/tmp/typst-headless";

await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const browserErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") {
    browserErrors.push(`console:${msg.text()}`);
  }
});
page.on("pageerror", (err) => {
  browserErrors.push(`pageerror:${String(err)}`);
});

const artifacts = [];
try {
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.getByText("Typst School Collaboration").waitFor({ timeout: 30000 });

  const shot1 = path.join(outDir, "01-landing.png");
  await page.screenshot({ path: shot1, fullPage: true });
  artifacts.push(shot1);

  const comment = page.getByPlaceholder("Add a comment");
  await comment.fill("Headless smoke comment");
  await page.getByRole("button", { name: "Add" }).click();

  const revision = page.getByPlaceholder("Revision summary");
  await revision.fill("Headless revision");
  await page.getByRole("button", { name: "Commit Revision" }).click();

  const tokenLabel = page.getByPlaceholder("Token label");
  await tokenLabel.fill("Headless token");
  await page.getByRole("button", { name: "Create token" }).click();

  await page
    .locator(".pdf-frame canvas")
    .first()
    .waitFor({ state: "attached", timeout: 30000 });
  await page.waitForTimeout(500);
  const shot2 = path.join(outDir, "02-after-actions.png");
  await page.screenshot({ path: shot2, fullPage: true });
  artifacts.push(shot2);

  const visibleErrors = await page.locator(".error").allInnerTexts();
  const unexpectedErrors = visibleErrors.filter(
    (msg) => !msg.startsWith("New token (shown once):")
  );
  const previewCanvasCount = await page.locator(".pdf-frame canvas").count();
  if (previewCanvasCount === 0) throw new Error("Preview canvas did not render");
  if (unexpectedErrors.length > 0) {
    throw new Error(`Unexpected UI errors: ${unexpectedErrors.join(" | ")}`);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        screenshots: artifacts,
        visibleErrors,
        previewCanvasCount,
        browserErrors
      },
      null,
      2
    )
  );
} catch (error) {
  const shot = path.join(outDir, "99-failure.png");
  await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
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
  await page.close();
  await browser.close();
}
