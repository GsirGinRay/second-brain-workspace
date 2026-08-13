# Optional Cloud Sync

Local mode is the default. Leave the server field empty to keep all activity on
the computer.

The first open-source extraction keeps remote cloud sync disabled and only
permits a localhost development adapter. This avoids granting a desktop WebView
permission to contact arbitrary Internet origins. A future compatible server
adapter will use an explicit origin allowlist, signed device requests and
three-way merge. It will receive structured task/project data, relative paths
and hashes; complete Markdown files and unrelated notes will stay on the
computer.

A public reference server is intentionally not bundled in the first extraction.
The protocol boundary is retained so a self-hosted adapter can be added without
changing the Markdown core or desktop UI.
