# Cloud Sync (private builds only)

The public Windows app is local-only. Settings explain that edits write to the
selected Markdown folder, and that a phone should open that same folder through
OneDrive, Dropbox, Google Drive, or Obsidian Sync. Cloud pairing, server origin,
and sync buttons are hidden unless a private Publisher profile is compiled in.

Private builds still use an explicit origin allowlist, signed device requests
and three-way merge. They receive structured task/project data, relative paths
and hashes; complete Markdown files and unrelated notes stay on the computer.

A public reference server is not bundled. The protocol boundary remains so a
self-hosted adapter can be added without changing the Markdown core.
