# Second Brain Workspace

[繁體中文](README.zh-TW.md)

A Windows task and project manager for people with a lot on their plate. Everything lives in ordinary Markdown files on your computer, so Obsidian, VS Code or any editor can open them too. No account, and your notes are never uploaded.

## Download and install

1. Download `Second-Brain-Workspace_x.y.z_x64-setup.exe` from the [latest release](https://github.com/GsirGinRay/second-brain-workspace/releases/latest).
2. Run the installer.
3. On first launch, pick a folder for your Markdown (or skip it and pick one before closing).

### "Windows protected your PC"

Windows SmartScreen shows this for new software without a paid code-signing certificate. It does not mean the file is harmful; the whole app is open source on this page.

1. Click **More info**.
2. Click **Run anyway**.

You only see this on the first install. Updates are downloaded by the app and checked against the public key built into it, so only official releases are installed.

### Updates

The app checks for a new version at launch and every 6 hours and asks before installing. Updates never touch your Markdown folder.

## Features

**What to do today**
- Today page: today's single most important task, a timeline and unscheduled tasks
- Load warning when today holds more hours than you have
- Focus mode: one task at a time with a timer
- Wrap-up: move what is left to tomorrow in one click and see what you finished
- Waiting list: follow up on work you handed off
- Review: tasks finished per week and the projects that moved most, up to 12 weeks back

**Planning**
- Month and week calendar with drag to reschedule; box-select several tasks to move or delete them together
- Task board, also as a table or a list
- Projects as cards, a table or by status, with their tasks, notes and attachments
- Knowledge: prompts and reference notes, with prompt import and export
- Search across fields: `+` for OR, `&` or a space for AND

**Capture**
- Quick add (`N`): type "Pay the phone bill tomorrow at 3pm" and the date and time are recognized
- Repeating tasks: daily, on weekdays, on a day of the month or a custom interval
- Checklists inside a task, with progress on the card
- Windows notifications before a task starts and a daily summary

**Phone**
- Phone inbox (free): pair once, then tasks you send from the phone (or its share menu) arrive end-to-end encrypted in your computer's inbox
- Today's list on the phone (paid Skool members): today and the next 7 days, tick off, reschedule or star tasks

**Also**
- Traditional Chinese and English, light and dark themes
- Undo and redo (`Ctrl+Z` / `Ctrl+Shift+Z`)
- An automatic `.ai/INDEX.md` so an AI assistant can find your projects, knowledge and today's tasks

## Your data is Markdown

Every action writes straight to the folder you chose; there is no separate database. A task looks like this:

```markdown
- [ ] #task Write the first tutorial [[Open Source Launch]] ⏳ 2026-08-15 ⏰ 09:30 ⏱ 30m

  ## Notes

  Full Markdown content for this task.
```

- Repeat rules and similar tokens follow Obsidian Tasks, so other tools can read them.
- Every write is preceded by a verified backup and done atomically, so a crash never leaves a half-written file.
- To read the same files on a phone, keep the folder in OneDrive, Dropbox, Google Drive or Obsidian Sync.

## Privacy

- Your Markdown is never uploaded; all reading and writing happens in the folder you chose.
- The app goes online only to check for updates and, after you pair a phone, to receive tasks sent from it.
- Phone tasks are encrypted on the phone and only your computer can open them. The relay at `inbox.aizbrain.com` keeps the unreadable data until your computer picks it up, then deletes it (14 days at most). See [docs/inbox-relay.md](docs/inbox-relay.md).

## For developers

Requires Node.js 20+, Rust stable, Microsoft WebView2 and the Tauri 2 Windows build prerequisites (Visual Studio Build Tools with the C++ workload, Windows SDK).

```bash
git clone https://github.com/GsirGinRay/second-brain-workspace.git
cd second-brain-workspace
npm install
npm run desktop:dev   # development mode
npm test              # TypeScript unit, integration and DOM tests
npm run rust:test     # Rust tests
npm run build         # type check and web build
```

| Folder | Contents |
| --- | --- |
| `apps/desktop` | Desktop app: Tauri 2 (Rust) with React and TypeScript |
| `apps/mobile-capture` | Phone web app (PWA) |
| `packages/brain-core` | Markdown parsing, task rules, encryption format |
| `packages/brain-ui` | Calendar, search and other shared logic |
| `services/inbox-relay` | Phone inbox relay server (Rust) |
| `examples/sample-vault` | Sample data (all made up) |

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [docs/architecture.md](docs/architecture.md) for the architecture.

## License

MIT
