# Project Instructions

## Purpose

Second Brain Workspace is an open-source, local-first task and project manager
for standard Markdown files. The Windows desktop application is the primary
product. Cloud sync is an optional adapter and must never be required for local
reading, editing, calendar, board, backup, or recovery features.

## Architecture

- `apps/desktop`: Tauri 2, React and Rust desktop application.
- `packages/brain-core`: Markdown parsing, formatting, merge and task rules.
- `packages/brain-ui`: framework-neutral calendar and repository helpers.
- `examples/sample-vault`: public synthetic Markdown fixtures only.
- `docs`: public architecture, installation and contributor documentation.

## Commands

```bash
npm install
npm test
npm run build
npm run rust:test
npm run desktop:installer
```

## Data and security rules

- Markdown is the long-term source of truth.
- Preserve BOM, CRLF, indentation, unknown task tokens and unrelated body text.
- Never commit real vault content, personal paths, email addresses, server
  credentials, pairing secrets, device private keys, database URLs or tokens.
- File paths must remain inside the user-selected canonical root. Reject links,
  junctions, reparse points, hidden directories and technical directories.
- Create and verify a backup before modifying Markdown. Use atomic writes and a
  recovery journal for multi-file operations.
- Cloud adapters accept HTTPS origins; localhost HTTP is development-only.

## Compatibility

The legacy `publisher-task` comment and `publisher_id` frontmatter key are
still read so original Publisher vaults open. On first load they are rewritten
to `second-brain-task` and `id`. They are not a dependency on the Publisher
product.
