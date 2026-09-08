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
file paths, today's journal, and unscheduled ideas. Daily journals live at
`日誌/YYYY-MM-DD.md` (legacy `05-每日工作台/` notes still open). Attachments copy
into `附件/<project or category>/`; Markdown stores only a relative link. Images
preview in the app; other files open with the system default. A task or today's
journal can be saved as a knowledge note without changing the original file;
project pages list knowledge that wikilinks the project. Settings can preview
and apply a layout migrator that moves legacy folders (`Projects/`,
`Collections/`, `05-每日工作台/`, `10-收件匣/`, `90-模板/`, `99-附件/`, numbered
knowledge folders) into the canonical tree. Filenames stay the same so
`[[wikilink]]` keep working; duplicate paths are listed and never deleted.
A verified ZIP backup is created before the move. Reassigning a task's project
moves the whole task block (the line and its indented notes) onto
`專案/<name>.md` or back to `收件匣/待辦.md`. Changing date or status still
edits in place.

A private Publisher build can still embed one exact HTTPS origin. That adapter
is not part of the public product and is not required to use the desktop app.
