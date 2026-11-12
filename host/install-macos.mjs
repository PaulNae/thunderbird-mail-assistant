// Registers the native messaging host for Thunderbird on macOS (current user).
// Plain Node ESM, no dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "mail_assistant";

// Thunderbird resolves user manifests via XREUserNativeManifests, which on macOS is
// ~/Library/Mozilla/NativeMessagingHosts (Thunderbird's data root is ~/Library, not
// ~/Library/Application Support).
// Confirmed by a live connectNative test in Thunderbird 160 on 2026-11-12.
export const DEFAULT_MANIFEST_DIR = path.join(
  os.homedir(),
  "Library",
  "Mozilla",
  "NativeMessagingHosts",
);

const hostDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(hostDir, "..");
// Host and launcher are copied here: Thunderbird must not execute files from ~/Documents
// (macOS privacy prompts).
export const DEFAULT_INSTALL_DIR = path.join(os.homedir(), "Library", "Application Support", "mail-assistant");
export const HOST_SCRIPT = path.join(hostDir, "host.mjs");
const MANIFEST_JSON = path.join(repoRoot, "extension", "manifest.json");

/** Quotes a string for POSIX sh using single quotes. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildLauncher({ claudePath, nodePath, hostScript }) {
  return [
    "#!/bin/sh",
    `export MAIL_ASSISTANT_CLAUDE=${shQuote(claudePath)}`,
    `exec ${shQuote(nodePath)} ${shQuote(hostScript)} "$@"`,
    "",
  ].join("\n");
}

export function buildManifest({ launcherPath, extensionId }) {
  return {
    name: HOST_NAME,
    description: "Mail Assistant native messaging host (runs Claude Code headless)",
    path: launcherPath,
    type: "stdio",
    allowed_extensions: [extensionId],
  };
}

export function readExtensionId(manifestPath = MANIFEST_JSON) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const id = manifest?.browser_specific_settings?.gecko?.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`No browser_specific_settings.gecko.id in ${manifestPath}`);
  }
  return id;
}

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveClaude(explicit) {
  if (explicit) {
    const abs = path.resolve(explicit);
    if (!isExecutableFile(abs)) throw new Error(`Not an executable file: ${abs}`);
    return abs;
  }
  const candidates = [];
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shell, ["-lc", "command -v claude"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });
    const line = out.trim().split("\n").pop();
    if (line && path.isAbsolute(line)) candidates.push(line);
  } catch {
    // Fall through to the fixed locations.
  }
  candidates.push(
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  );
  const found = candidates.find(isExecutableFile);
  if (!found) {
    throw new Error(
      "Claude Code (claude) not found. Install Claude Code and log in, or pass --claude <path>.",
    );
  }
  return found;
}

export function parseArgs(argv) {
  const opts = { uninstall: false, print: false };
  const valueFlags = { "--claude": "claude", "--manifest-dir": "manifestDir", "--install-dir": "installDir" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--uninstall") opts.uninstall = true;
    else if (arg === "--print") opts.print = true;
    else if (arg in valueFlags) {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      opts[valueFlags[arg]] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

export function main(argv) {
  const out = (s) => process.stdout.write(`${s}\n`);
  const opts = parseArgs(argv);
  if (process.platform !== "darwin" && !opts.manifestDir) {
    throw new Error("This installer supports macOS only (use --manifest-dir to override).");
  }
  const manifestDir = path.resolve(opts.manifestDir ?? DEFAULT_MANIFEST_DIR);
  const installDir = path.resolve(opts.installDir ?? DEFAULT_INSTALL_DIR);
  const launcherPath = path.join(installDir, "launcher.sh");
  const hostCopy = path.join(installDir, "host.mjs");
  const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);

  if (opts.uninstall) {
    for (const p of [manifestPath, launcherPath, hostCopy]) {
      if (opts.print) out(`Would remove ${p}`);
      else {
        fs.rmSync(p, { force: true });
        out(`Removed ${p}`);
      }
    }
    if (!opts.print) {
      try {
        fs.rmdirSync(installDir); // only if empty
      } catch {
        // not empty or missing
      }
    }
    return;
  }

  const claudePath = resolveClaude(opts.claude);
  const launcher = buildLauncher({ claudePath, nodePath: process.execPath, hostScript: hostCopy });
  const manifest = buildManifest({ launcherPath, extensionId: readExtensionId() });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  if (opts.print) {
    out(`# ${launcherPath}\n${launcher}`);
    out(`# ${manifestPath}\n${manifestText}`);
    out(`claude: ${claudePath}`);
    return;
  }
  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(HOST_SCRIPT, hostCopy);
  fs.writeFileSync(launcherPath, launcher);
  fs.chmodSync(launcherPath, 0o755);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(manifestPath, manifestText);
  out(`Copied host: ${hostCopy}`);
  out(`Wrote launcher: ${launcherPath}`);
  out(`Wrote manifest: ${manifestPath}`);
  out(`Claude path: ${claudePath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
