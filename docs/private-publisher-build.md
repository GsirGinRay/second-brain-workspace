# Private Publisher build profile

The public build contains no remote Publisher origin and remains fully usable as
a local-only Markdown desktop app. Remote HTTPS is available only when a private
profile is supplied at build time; Rust embeds and enforces that single exact
origin. The WebView CSP does not receive HTTPS network access.

## Local private files

Copy the two `*.example.json` files in `apps/desktop/private/` to the same names
without `.example`. These local JSON files are ignored by Git:

- `publisher-profile.json` supplies the exact HTTPS origin.
- `publisher-profile.tauri.json` supplies the private product name, version, and
  a distinct application identifier. Keeping a distinct identifier gives this
  app a new DPAPI-protected device identity instead of copying a legacy key.

Build the private NSIS installer with:

```bash
npm run desktop:publisher-installer
```

The build script validates the private origin, exposes it only to the Rust
compiler process, and applies the private Tauri overlay. Do not add tokens,
email addresses, database URLs, Redis URLs, or private keys to either profile.

## First synchronization

1. Install and open the private preview build, then select the Markdown vault.
2. In **同步與設定**, confirm **Publisher 同步已啟用** and choose **開始配對**.
3. Enter the displayed eight-character code on the Publisher device page. The
   app stores its newly issued device ID while its private key stays protected
   by Windows DPAPI in this preview application's own data directory.
4. The first run creates a Shadow preview only. Review the task, project,
   conflict, and bootstrap counts, then explicitly approve the first write.
5. Later changes synchronize automatically. Server changes are merged back only
   through the existing backup, atomic-write, and recovery-journal pipeline.

Only structured task/project snapshots, relative source paths, and SHA-256 file
hashes are sent. Markdown bodies and attachments are not part of the request.
