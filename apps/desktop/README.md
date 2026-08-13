# Desktop Application

The Tauri desktop app is the primary Second Brain Workspace product. It reads
and writes a user-selected Markdown directory without requiring Obsidian or a
cloud account.

## Run

From the repository root:

```bash
npm install
npm run desktop:dev
```

## Build

```bash
npm run desktop:installer
```

The NSIS installer is generated under
`apps/desktop/src-tauri/target/release/bundle/nsis/`.

Remote cloud access is disabled in the default open-source build. Localhost is
allowed for protocol development and tests. See `docs/cloud-sync.md`.
