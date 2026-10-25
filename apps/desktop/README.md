# Desktop Application

The Tauri desktop app is the primary aizbrain product. It reads
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

The app has no cloud sync. It only goes online to check for updates and, once a
phone is paired, to reach the phone inbox (`docs/inbox-relay.md`).
