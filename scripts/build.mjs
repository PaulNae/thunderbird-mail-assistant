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
  "display/popup": "extension/display/popup.ts",
  "chat/chat": "extension/chat/chat.ts",
  "options/options": "extension/options/options.ts",
};

// Static files and folders copied as-is, relative to extension/.
const staticFiles = [
  "manifest.json",
  "_locales",
  "icons",
  "shared/popup.css",
  "compose/popup.html",
  "display/popup.html",
  "chat/chat.html",
  "options/options.html",
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

// The compose editor content script is injected into the same frame more than once. It must be
// an IIFE so its module state is not leaked as top-level globals (a re-injection would reset them).
await build({
  absWorkingDir: root,
  entryPoints: { "compose/editor": "extension/compose/editor.ts" },
  outdir: "dist",
  bundle: true,
  format: "iife",
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

