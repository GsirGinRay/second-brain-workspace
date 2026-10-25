# Contributing

歡迎回報問題或送 Pull Request。中文或英文都可以。
Issues and pull requests are welcome, in Chinese or English.

## Ground rules

1. Use the synthetic data under `examples/sample-vault`. Never put a real
   vault, personal paths, email addresses or keys in a fixture, screenshot or
   issue.
2. Add a failing test before changing Markdown parsing, formatting, merge,
   backup, path or recovery behavior. Markdown is the user's data: preserve BOM,
   CRLF, indentation, unknown task tokens and unrelated text.
3. Run the full checks before opening a pull request:

   ```bash
   npm test            # TypeScript unit, integration and DOM tests
   npm run rust:test   # desktop Rust tests
   npm run relay:test  # phone inbox relay tests
   npm run build       # type check and web build
   ```

4. Explain any data-format or permission change in the pull request.
5. Do not broaden the Tauri Content Security Policy to arbitrary Internet
   origins. The app only talks to the update feed and the phone inbox relay.

## Releasing (maintainers)

Installed apps poll the signed `latest.json` of the newest
[GitHub Release](https://github.com/GsirGinRay/second-brain-workspace/releases)
at launch and every six hours. Pushing commits alone does not notify anyone.

1. Bump the version in `package.json`, `apps/desktop/package.json`,
   `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/tauri.conf.json`
   and `apps/desktop/src/ui-contract.test.ts`.
2. Build the signed installer and manifest:
   `npm run desktop:release -- --notes "What changed"`.
3. Publish when the build looks right:
   `npm run desktop:release -- --notes "What changed" --publish`.

Updates are verified with the minisign public key in `tauri.conf.json`. The
private key lives outside the repository (`TAURI_SIGNING_PRIVATE_KEY` or
`~/.tauri/second-brain-workspace.key`). Back it up: without it, installed apps
can never receive another update.

The Windows package is named `aizbrain` and keeps the identifier
`app.secondbrain.workspace`, so settings and keys stay where they are. A newer
installer finds the installed version, removes it through its uninstaller and
installs the update without touching the user's Markdown folder. Up to 0.8.6 the
product name was `Second Brain Workspace`; NSIS keys the install folder by that
name, so `src-tauri/windows/installer-hooks.nsh` removes the old install first.
Keep the product name stable from now on.
