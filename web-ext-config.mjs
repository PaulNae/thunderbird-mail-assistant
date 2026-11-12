import { fileURLToPath } from "node:url";

// Config for `web-ext run`: starts Thunderbird with the built add-on from dist/
// in a dedicated, persistent test profile (never the user's real profile).
export default {
  sourceDir: "dist",
  run: {
    target: ["firefox-desktop"],
    firefox: "/Applications/Thunderbird.app/Contents/MacOS/thunderbird",
    firefoxProfile: fileURLToPath(new URL(".tb-dev-profile", import.meta.url)),
    profileCreateIfMissing: true,
    keepProfileChanges: true,
    // -purgecaches: the persistent profile's startup cache otherwise keeps stale
    // _locales strings of the add-on across restarts (same add-on version).
    args: ["-no-remote", "-purgecaches"],
  },
};
