# Second Brain Workspace

A local-first desktop workspace for tasks and projects stored in ordinary
Markdown files. Use it with Obsidian, VS Code, Typora, Notepad++, or any editor.

## What works without a server

- Windows desktop application
- Today, month/week calendar, board and project views
- Fast task creation and editing
- Markdown folder scanning and file watching
- Local backup, atomic writes and crash-recovery journal
- Offline use

Cloud sync is optional. Configure a compatible HTTPS server only when you want
to view or edit the same task mirror from a phone or browser.

## Development

Requirements: Node.js 20+, Rust stable, Microsoft WebView2 and the Tauri Windows
build prerequisites.

```bash
npm install
npm test
npm run build
npm run rust:test
npm run desktop:dev
```

Build the Windows NSIS installer:

```bash
npm run desktop:installer
```

The installer is written to
`apps/desktop/src-tauri/target/release/bundle/nsis/`.

## Data format

```markdown
- [ ] #task Write the first tutorial [[Open Source Launch]] ⏳ 2026-08-15
```

See [docs/architecture.md](docs/architecture.md) and
[docs/cloud-sync.md](docs/cloud-sync.md) for the product boundaries.

## Privacy

The application does not upload Markdown bodies. A cloud adapter, when enabled,
receives only structured task/project fields, relative source paths and hashes.

## License

MIT
