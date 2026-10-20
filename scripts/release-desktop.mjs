// Builds a signed Windows installer plus the latest.json manifest that
// installed apps poll for updates. Publishing is a separate, explicit step:
//
//   npm run desktop:release -- --notes "What changed"            build only
//   npm run desktop:release -- --notes "What changed" --publish  also create the GitHub Release
//
// The minisign private key never enters the repository. It is read from
// TAURI_SIGNING_PRIVATE_KEY (key text or path) or ~/.tauri/second-brain-workspace.key.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const REPO = "GsirGinRay/second-brain-workspace";
const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const version = config.version;
const tag = `v${version}`;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const notes = argValue("--notes")?.trim();
const publish = process.argv.includes("--publish");
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`tauri.conf.json version is invalid: ${version}`);
if (!notes) throw new Error('Pass release notes for members: --notes "What changed"');

const defaultKeyPath = join(homedir(), ".tauri", "second-brain-workspace.key");
const signingKey = process.env.TAURI_SIGNING_PRIVATE_KEY ?? (existsSync(defaultKeyPath) ? defaultKeyPath : undefined);
if (!signingKey) {
  throw new Error(`Updater signing key not found. Set TAURI_SIGNING_PRIVATE_KEY or create ${defaultKeyPath}.`);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this release through npm so npm_execpath is available");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

run(
  process.execPath,
  [npmCli, "--workspace", "@second-brain/desktop", "run", "tauri:installer", "--", "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: true } })],
  {
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: signingKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    },
  },
);

const bundleDir = resolve(root, "apps/desktop/src-tauri/target/release/bundle/nsis");
const builtInstaller = join(bundleDir, `${config.productName}_${version}_x64-setup.exe`);
const builtSignature = `${builtInstaller}.sig`;
if (!existsSync(builtInstaller) || !existsSync(builtSignature)) {
  throw new Error(`Signed installer not found: ${builtInstaller}(.sig)`);
}

// GitHub rewrites spaces in asset names, so publish a URL-safe file name.
const assetName = `Second-Brain-Workspace_${version}_x64-setup.exe`;
const releaseDir = resolve(root, "apps/desktop/src-tauri/target/release/updater", tag);
mkdirSync(releaseDir, { recursive: true });
const installer = join(releaseDir, assetName);
copyFileSync(builtInstaller, installer);

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(builtSignature, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/${assetName}`,
    },
  },
};
const manifestPath = join(releaseDir, "latest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\nRelease ${tag} is ready in ${releaseDir}`);
if (!publish) {
  console.log("Nothing was published. Re-run with --publish to create the GitHub Release.");
} else {
  // Tag the exact commit that was built; gh rejects it if it is not pushed yet.
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Could not resolve the commit to release");
  run("gh", ["release", "create", tag, installer, manifestPath, "--repo", REPO, "--target", head, "--title", `Second Brain Workspace ${version}`, "--notes", notes, "--latest"]);
  console.log(`Published ${tag}. Installed apps will offer the update on their next check.`);
}
