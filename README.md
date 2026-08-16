# Second Brain Workspace

A local-first desktop workspace for tasks, outcome projects, and reference collections stored in ordinary
Markdown files. Use it with Obsidian, VS Code, Typora, Notepad++, or any editor.

## What works without a server

- Windows desktop application
- Today, month/week calendar, task board, project list/status views, and local collections
- Traditional Chinese and English UI with persistent light and dark themes
- Cross-field search with `+` for OR, `&` (or spaces) for AND, and quoted phrases
- Full Markdown editing and safe preview for tasks, projects, and collections
- Beginner draft mode: capture first, choose the Markdown folder before closing
- First-run guidance in Traditional Chinese and English
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

The Windows package keeps the stable product identity `Second Brain Workspace`
(`app.secondbrain.workspace`). Installing a newer NSIS package detects the same
installed product, uninstalls the older version through its registered uninstaller,
and installs the update without deleting the user's Markdown folder. Portable or
downloaded installer files are not removed because they are not installed apps.

## Data format

```markdown
- [ ] #task Write the first tutorial [[Open Source Launch]] ⏳ 2026-08-15

<!-- second-brain-task-content:00000000-0000-4000-8000-000000000000:start -->
## Notes

Full Markdown content for this task.
<!-- second-brain-task-content:00000000-0000-4000-8000-000000000000:end -->
```

See [docs/architecture.md](docs/architecture.md) and
[docs/cloud-sync.md](docs/cloud-sync.md) for the product boundaries.

## Privacy

The application does not upload Markdown bodies. A cloud adapter, when enabled,
receives only structured task/project fields, relative source paths and hashes.
Collection Markdown bodies are indexed locally and are not added to cloud sync plans.

Projects use `type: project` and have a finite lifecycle (`planning`, `active`,
`paused`, `done`, or `archived`). Long-lived prompts and reference notes use
`type: collection` with optional `category` and `importance` frontmatter.

Task status `waiting` means work is blocked on a reply, material, approval,
date, or another external condition; it remains distinct from a project being
intentionally `paused`.

## License

MIT
