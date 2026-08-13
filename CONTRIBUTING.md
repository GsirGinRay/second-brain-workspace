# Contributing

1. Use synthetic data under `examples/sample-vault`; never use a real vault in
   a fixture or screenshot.
2. Add a failing test before changing Markdown parsing, formatting, merge,
   backup, path or recovery behavior.
3. Run `npm test`, `npm run build`, and `npm run rust:test` before opening a pull
   request.
4. Explain any data-format or permission change in the pull request.

Cloud adapters must use an explicit origin allowlist. Do not broaden the Tauri
Content Security Policy to arbitrary Internet origins.
