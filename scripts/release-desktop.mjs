// Builds a signed Windows installer plus the latest.json manifest that
// installed apps poll for updates. Publishing is a separate, explicit step:
//
//   npm run desktop:release -- --notes "What changed"            build only
//   npm run desktop:release -- --notes "What changed" --publish  also create the GitHub Release
//
// The macOS app is built by .github/workflows/macos.yml for the pushed HEAD commit.
// The script waits for that run, downloads it and signs the updater bundle here;
// pass --skip-mac to release Windows only.
//
// The minisign private key never enters the repository or CI. It is read from
// TAURI_SIGNING_PRIVATE_KEY (key text or path) or ~/.tauri/second-brain-workspace.key.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const skipMac = process.argv.includes("--skip-mac");
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

const signingEnv = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: signingKey,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
};

const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Could not resolve the commit to release");

// Downloads the macOS workflow's artifact for HEAD, waiting for the run if needed.
function downloadMacBuild(targetDir) {
  const listed = spawnSync(
    "gh",
    ["run", "list", "--repo", REPO, "--workflow", "macos.yml", "--commit", head, "--json", "databaseId,status,conclusion", "--limit", "1"],
    { cwd: root, encoding: "utf8" },
  );
  if (listed.status !== 0) throw new Error(`gh run list failed: ${listed.stderr}`);
  const [macRun] = JSON.parse(listed.stdout || "[]");
  if (!macRun) throw new Error(`No macOS build for ${head}. Push the commit first, or pass --skip-mac.`);
  if (macRun.status !== "completed") {
    console.log(`Waiting for the macOS build (run ${macRun.databaseId})...`);
    run("gh", ["run", "watch", String(macRun.databaseId), "--repo", REPO, "--exit-status"]);
  } else if (macRun.conclusion !== "success") {
    throw new Error(`The macOS build for ${head} ended with ${macRun.conclusion}`);
  }
  rmSync(targetDir, { recursive: true, force: true });
  run("gh", ["run", "download", String(macRun.databaseId), "--repo", REPO, "--name", "aizbrain-macos", "--dir", targetDir]);
}

run(
  process.execPath,
  [npmCli, "--workspace", "@second-brain/desktop", "run", "tauri:installer", "--", "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: true } })],
  { env: signingEnv },
);

const bundleDir = resolve(root, "apps/desktop/src-tauri/target/release/bundle/nsis");
const builtInstaller = join(bundleDir, `${config.productName}_${version}_x64-setup.exe`);
const builtSignature = `${builtInstaller}.sig`;
if (!existsSync(builtInstaller) || !existsSync(builtSignature)) {
  throw new Error(`Signed installer not found: ${builtInstaller}(.sig)`);
}

// GitHub rewrites spaces in asset names, so publish a URL-safe file name.
const assetName = `aizbrain_${version}_x64-setup.exe`;
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
const assets = [installer];

if (!skipMac) {
  const macDir = join(releaseDir, "macos-artifact");
  downloadMacBuild(macDir);
  const diskImage = join(releaseDir, `aizbrain_${version}_universal.dmg`);
  const updaterName = `aizbrain_${version}_universal.app.tar.gz`;
  const updaterBundle = join(releaseDir, updaterName);
  copyFileSync(join(macDir, "aizbrain_universal.dmg"), diskImage);
  copyFileSync(join(macDir, "aizbrain_universal.app.tar.gz"), updaterBundle);
  // The signer takes a key path and key text through different variables.
  const keyIsFile = existsSync(signingKey);
  const signerEnv = { ...signingEnv };
  if (keyIsFile) {
    delete signerEnv.TAURI_SIGNING_PRIVATE_KEY;
    signerEnv.TAURI_SIGNING_PRIVATE_KEY_PATH = signingKey;
  }
  run(process.execPath, [npmCli, "--workspace", "@second-brain/desktop", "exec", "--", "tauri", "signer", "sign", updaterBundle], { env: signerEnv });
  const macEntry = {
    signature: readFileSync(`${updaterBundle}.sig`, "utf8").trim(),
    url: `https://github.com/${REPO}/releases/download/${tag}/${updaterName}`,
  };
  // One universal build serves both Apple Silicon and Intel Macs.
  manifest.platforms["darwin-aarch64"] = macEntry;
  manifest.platforms["darwin-x86_64"] = macEntry;
  assets.push(diskImage, updaterBundle);
}

const manifestPath = join(releaseDir, "latest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\nRelease ${tag} is ready in ${releaseDir}`);
if (!publish) {
  console.log("Nothing was published. Re-run with --publish to create the GitHub Release.");
} else {
  // Tag the exact commit that was built; gh rejects it if it is not pushed yet.
  run("gh", ["release", "create", tag, ...assets, manifestPath, "--repo", REPO, "--target", head, "--title", `aizbrain ${version}`, "--notes", notes, "--latest"]);
  console.log(`Published ${tag}. Installed apps will offer the update on their next check.`);
}
