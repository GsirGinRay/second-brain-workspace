# Extraction Notes

This repository was extracted from a private Publisher deployment as a clean,
new Git history. Publisher publishing, Skool, social accounts, Auth.js, Zeabur
configuration, PostgreSQL data and Redis configuration were intentionally not
copied.

The legacy `publisher-task` comment and `publisher_id` frontmatter key remain
for existing Markdown compatibility. They may be migrated only through a
versioned, backed-up data migration.

The legacy `.publisher-sync.lock` filename is also retained so the original and
extracted desktop applications cannot write the same vault concurrently.
