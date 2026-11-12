// Bundles the extension into dist/ with esbuild (no minification) and copies static files.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "extension");
const dist = path.join(root, "dist");

// Add further entry points (e.g. popups) here, one line each.
const entryPoints = {
  "background/background": "extension/background/background.ts",
  "compose/popup": "extension/compose/popup.ts",
  "compose/editor": "extension/compose/editor.ts",
  "display/popup": "extension/display/popup.ts",
};

// Static files and folders copied as-is, relative to extension/.
const staticFiles = [
  "manifest.json",
  "_locales",
  "icons",
  "shared/popup.css",
  "compose/popup.html",
  "display/popup.html",
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints,
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: false,
  sourcemap: "linked",
  logLevel: "info",
});

for (const file of staticFiles) {
  await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
  await cp(path.join(src, file), path.join(dist, file), { recursive: true });
}

