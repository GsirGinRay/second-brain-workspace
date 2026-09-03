# Architecture

```text
Any Markdown editor  ↔  the same folder on disk  ↔  Second Brain Workspace Desktop
```

The public desktop application is local-first. Choosing a Markdown folder makes
that folder the source of truth: checking a task, changing a date, or deleting
something writes those files on the computer. There is no separate database.

To use the same files on a phone, put the folder in OneDrive, Dropbox, Google
Drive, or Obsidian Sync and open it with a Markdown app. The public build does
not include built-in cloud sync.

`brain-core` owns the durable Markdown format and merge rules. `brain-ui` owns
portable calendar and repository contracts. The desktop app owns native file
access, backups, watchers and recovery. `.ai/INDEX.md` is regenerated from the
vault so an AI can find projects, knowledge, today's and overdue tasks with
file paths, and unscheduled ideas.

A private Publisher build can still embed one exact HTTPS origin. That adapter
is not part of the public product and is not required to use the desktop app.
