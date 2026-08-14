import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const profilePath = resolve(root, "apps/desktop/private/publisher-profile.json");
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const tauriProfilePath = resolve(
  root,
  "apps/desktop/private/publisher-profile.tauri.json",
);
const tauriProfile = JSON.parse(readFileSync(tauriProfilePath, "utf8"));
const origin = new URL(profile.publisherOrigin);

if (
  origin.protocol !== "https:"
  || origin.origin !== profile.publisherOrigin
  || origin.username
  || origin.password
) {
  throw new Error("publisherOrigin must be an exact credential-free HTTPS origin");
}

const mainWindow = tauriProfile.app?.windows?.find(
  (windowConfig) => windowConfig.label === "main",
);
if (!mainWindow || mainWindow.dragDropEnabled !== false) {
  throw new Error(
    "private Publisher main window must set dragDropEnabled to false for Windows HTML5 task drag and drop",
  );
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this build through npm so npm_execpath is available");
const result = spawnSync(
  process.execPath,
  [npmCli, "--workspace", "@second-brain/desktop", "run", "tauri:installer", "--", "--config", "private/publisher-profile.tauri.json"],
  {
    cwd: root,
    env: { ...process.env, SECOND_BRAIN_PUBLISHER_ORIGIN: origin.origin },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
