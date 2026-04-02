import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const cacheRoot = path.join(webRoot, ".cache", "typst-assets");
const publicFontsRoot = path.join(webRoot, "public", "vendor", "typst-assets", "fonts");
const publicManifestPath = path.join(publicFontsRoot, ".manifest.json");

const COMPILER_PACKAGE_NAME = "@myriaddreamin/typst-ts-web-compiler";
const DEFAULT_TYPST_ASSETS_TAG = "v0.13.1";
const compilerVersionToAssetsTag = {
  "0.7.0-rc2": "v0.13.1"
};

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

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

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

function hashList(values) {
  const hasher = createHash("sha256");
  for (const value of values) hasher.update(value).update("\n");
  return hasher.digest("hex");
}

async function detectTypstAssetsTag() {
  const envOverride = process.env.TYPST_ASSETS_TAG?.trim();
  if (envOverride) return envOverride;
  const packageJsonPath = path.join(webRoot, "node_modules", ...COMPILER_PACKAGE_NAME.split("/"), "package.json");
  try {
    const packageJson = await readJson(packageJsonPath);
    const compilerVersion = String(packageJson.version || "").trim();
    if (compilerVersion && compilerVersionToAssetsTag[compilerVersion]) {
      return compilerVersionToAssetsTag[compilerVersion];
    }
    process.stdout.write(
      `[typst-assets] no mapped assets tag for ${COMPILER_PACKAGE_NAME}@${compilerVersion || "unknown"}, fallback ${DEFAULT_TYPST_ASSETS_TAG}\n`
    );
  } catch {
    process.stdout.write(
      `[typst-assets] compiler package metadata missing, fallback ${DEFAULT_TYPST_ASSETS_TAG}\n`
    );
  }
  return DEFAULT_TYPST_ASSETS_TAG;
}

async function readManifestIfAny() {
  if (!(await fileExists(publicManifestPath))) return null;
  try {
    const manifest = await readJson(publicManifestPath);
    if (!manifest || typeof manifest !== "object") return null;
    return manifest;
  } catch {
    return null;
  }
}

async function writeManifest(manifest) {
  await fs.writeFile(publicManifestPath, JSON.stringify(manifest, null, 2));
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

async function syncFont(typstAssetsTag, fontFile) {
  const versionedCacheDir = path.join(cacheRoot, typstAssetsTag, "files", "fonts");
  await ensureDir(versionedCacheDir);
  await ensureDir(publicFontsRoot);

  const cachedFile = path.join(versionedCacheDir, fontFile);
  if (!(await fileExists(cachedFile))) {
    const remoteFontBase = `https://raw.githubusercontent.com/typst/typst-assets/${typstAssetsTag}/files/fonts/`;
    const url = `${remoteFontBase}${fontFile}`;
    process.stdout.write(`[typst-assets] download ${fontFile}\n`);
    await downloadToFile(url, cachedFile);
  }

  const dest = path.join(publicFontsRoot, fontFile);
  await fs.copyFile(cachedFile, dest);
}

async function main() {
  const typstAssetsTag = await detectTypstAssetsTag();
  const fontsHash = hashList(textFonts);
  const existingManifest = await readManifestIfAny();
  if (
    existingManifest &&
    existingManifest.typst_assets_tag === typstAssetsTag &&
    existingManifest.fonts_hash === fontsHash
  ) {
    const allPresent = await Promise.all(
      textFonts.map((font) => fileExists(path.join(publicFontsRoot, font)))
    );
    if (allPresent.every(Boolean)) {
      process.stdout.write(
        `[typst-assets] already synced (tag ${typstAssetsTag}, ${textFonts.length} fonts)\n`
      );
      return;
    }
  }
  for (const font of textFonts) {
    await syncFont(typstAssetsTag, font);
  }
  await writeManifest({
    typst_assets_tag: typstAssetsTag,
    fonts_hash: fontsHash,
    font_count: textFonts.length,
    generated_at: new Date().toISOString(),
    source: COMPILER_PACKAGE_NAME
  });
  process.stdout.write(
    `[typst-assets] synced ${textFonts.length} text font assets (tag ${typstAssetsTag}) to public/vendor/typst-assets/fonts\n`
  );
}

main().catch((error) => {
  console.error(`[typst-assets] sync failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
