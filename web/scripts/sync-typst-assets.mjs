import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const cacheRoot = path.join(webRoot, ".cache", "typst-assets");
const publicFontsRoot = path.join(webRoot, "public", "vendor", "typst-assets", "fonts");

const typstAssetsVersion = "v0.13.1";
const remoteFontBase = `https://raw.githubusercontent.com/typst/typst-assets/${typstAssetsVersion}/files/fonts/`;

const textFonts = [
  "DejaVuSansMono-Bold.ttf",
  "DejaVuSansMono-BoldOblique.ttf",
  "DejaVuSansMono-Oblique.ttf",
  "DejaVuSansMono.ttf",
  "LibertinusSerif-Bold.otf",
  "LibertinusSerif-BoldItalic.otf",
  "LibertinusSerif-Italic.otf",
  "LibertinusSerif-Regular.otf",
  "LibertinusSerif-Semibold.otf",
  "LibertinusSerif-SemiboldItalic.otf",
  "NewCM10-Bold.otf",
  "NewCM10-BoldItalic.otf",
  "NewCM10-Italic.otf",
  "NewCM10-Regular.otf",
  "NewCMMath-Bold.otf",
  "NewCMMath-Book.otf",
  "NewCMMath-Regular.otf"
];

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadToFile(url, outFile) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      await fs.writeFile(outFile, bytes);
      return;
    }
    if (response.status !== 429 || attempt === maxAttempts) {
      throw new Error(`Download failed: ${url} (${response.status})`);
    }
    const waitMs = attempt * 800;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function syncFont(fontFile) {
  const versionedCacheDir = path.join(cacheRoot, typstAssetsVersion, "files", "fonts");
  await ensureDir(versionedCacheDir);
  await ensureDir(publicFontsRoot);

  const cachedFile = path.join(versionedCacheDir, fontFile);
  if (!(await fileExists(cachedFile))) {
    const url = `${remoteFontBase}${fontFile}`;
    process.stdout.write(`[typst-assets] download ${fontFile}\n`);
    await downloadToFile(url, cachedFile);
  }

  const dest = path.join(publicFontsRoot, fontFile);
  await fs.copyFile(cachedFile, dest);
}

async function main() {
  for (const font of textFonts) {
    await syncFont(font);
  }
  process.stdout.write(
    `[typst-assets] synced ${textFonts.length} text font assets to public/vendor/typst-assets/fonts\n`
  );
}

main().catch((error) => {
  console.error(`[typst-assets] sync failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
