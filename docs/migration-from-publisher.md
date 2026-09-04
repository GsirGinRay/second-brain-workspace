# Extraction Notes

This repository was extracted from a private Publisher deployment as a clean,
new Git history. Publisher publishing, Skool, social accounts, Auth.js, Zeabur
configuration, PostgreSQL data and Redis configuration were intentionally not
copied.

The legacy `publisher-task` comment and `publisher_id` frontmatter key are still
read so existing Publisher Markdown opens. The first vault load rewrites them
to `second-brain-task` and `id` through the backed-up scan migration.

The legacy `.publisher-sync.lock` filename is also retained so the original and
extracted desktop applications cannot write the same vault concurrently.
