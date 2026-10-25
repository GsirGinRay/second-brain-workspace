//! `aizbrain --aizbrain-hook …`: lifecycle hooks for AI coding tools.
//!
//! Claude Code, Codex, Gemini CLI and Grok Build call the app binary at two
//! moments of a session:
//!
//! - **session-start** prints today's most important task and the latest AI
//!   handoffs from `.ai/INDEX.md`, so the AI starts with the vault's context.
//! - **stop** runs when the AI finishes a turn. If the turn changed Markdown in
//!   the vault but added no AI work log, it asks the AI once to write one
//!   (see the write-back rules in `.ai/INSTRUCTIONS.md`).
//!
//! The hook only reads the vault, never the conversation, and it fails open:
//! anything it cannot read or understand lets the tool carry on unchanged.
//! `install` / `uninstall` add or remove only the entries this binary owns.

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const HOOK_FLAG: &str = "--aizbrain-hook";
const INSTRUCTIONS: &str = ".ai/INSTRUCTIONS.md";
const INDEX: &str = ".ai/INDEX.md";
const WORKLOG_DIR: &str = ".ai/worklog";
/// Same marker as `WRITE_BACK_MARKER` in `packages/brain-core/src/scaffold.ts`.
const WRITE_BACK_MARKER: &str = "<!-- aizbrain:write-back v1 -->";
const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 12;
const STATE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    SessionStart,
    Stop,
}

/// What the hook prints and returns. Exit 2 with a reason on stderr is the
/// one "keep working" signal every supported tool understands.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct HookOutcome {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Entry point for `main`: `Some(exit code)` when the binary was started as a hook.
pub fn run_from_args(args: &[String]) -> Option<i32> {
    if args.get(1).map(String::as_str) != Some(HOOK_FLAG) {
        return None;
    }
    let command = args.get(2).map(String::as_str).unwrap_or("");
    let outcome = match command {
        "session-start" | "stop" => {
            let event = if command == "stop" { HookEvent::Stop } else { HookEvent::SessionStart };
            let antigravity = args[3..].windows(2).any(|pair| pair[0] == "--format" && pair[1] == "antigravity");
            let mut input = String::new();
            let _ = std::io::stdin().take(4 * 1024 * 1024).read_to_string(&mut input);
            match state_dir() {
                Some(dir) if antigravity => run_antigravity_hook(event, &input, &dir, SystemTime::now()),
                Some(dir) => run_hook(event, &input, &dir, SystemTime::now()),
                None => HookOutcome::default(),
            }
        }
        "install" | "uninstall" => run_install_command(command == "install", &args[3..]),
        _ => HookOutcome {
            stderr: format!("usage: {HOOK_FLAG} session-start|stop|install|uninstall"),
            exit_code: 1,
            ..HookOutcome::default()
        },
    };
    if !outcome.stdout.is_empty() {
        print!("{}", outcome.stdout);
    }
    if !outcome.stderr.is_empty() {
        eprint!("{}", outcome.stderr);
    }
    Some(outcome.exit_code)
}

fn state_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(base).join("aizbrain").join("hooks"))
}

/// Read a field that tools spell in snake_case (Claude, Codex, Gemini) or
/// camelCase (Grok sends both).
fn field<'a>(input: &'a Value, snake: &str, camel: &str) -> Option<&'a Value> {
    input.get(snake).or_else(|| input.get(camel))
}

fn field_str<'a>(input: &'a Value, snake: &str, camel: &str) -> Option<&'a str> {
    field(input, snake, camel).and_then(Value::as_str)
}

fn field_bool(input: &Value, snake: &str, camel: &str) -> bool {
    field(input, snake, camel).and_then(Value::as_bool).unwrap_or(false)
}

/// Run one hook event. Pure apart from the vault and `state_dir`, for tests.
pub fn run_hook(event: HookEvent, raw_input: &str, state_dir: &Path, now: SystemTime) -> HookOutcome {
    let input: Value = serde_json::from_str(raw_input).unwrap_or(Value::Null);
    if !input.is_object() {
        return HookOutcome::default();
    }
    let cwd = field_str(&input, "cwd", "cwd")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("CLAUDE_PROJECT_DIR").map(PathBuf::from))
        .or_else(|| std::env::var_os("GEMINI_PROJECT_DIR").map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok());
    let Some(vault) = cwd.as_deref().and_then(find_vault_root) else {
        return HookOutcome::default();
    };
    let session = field_str(&input, "session_id", "sessionId").and_then(session_file_name);
    match event {
        HookEvent::SessionStart => session_start(&vault, session.as_deref(), state_dir, now),
        HookEvent::Stop => stop(&input, &vault, session.as_deref(), state_dir, now),
    }
}

/// Antigravity (CLI, IDE and Antigravity 2.0) sends camelCase input without a
/// `cwd`, takes context as `injectSteps`, and keeps working on
/// `{"decision": "continue"}` instead of exit 2. Translate both ways.
pub fn run_antigravity_hook(event: HookEvent, raw_input: &str, state_dir: &Path, now: SystemTime) -> HookOutcome {
    let allow = HookOutcome { stdout: "{}".to_owned(), ..HookOutcome::default() };
    let Ok(input) = serde_json::from_str::<Value>(raw_input) else { return allow };
    // Only a normal turn end may be held back; errors, cancels and limits pass.
    if event == HookEvent::Stop
        && input.get("terminationReason").and_then(Value::as_str).is_some_and(|reason| reason != "NO_TOOL_CALL")
    {
        return allow;
    }
    let mut normalized = Map::new();
    if let Some(cwd) = input.get("workspacePaths").and_then(Value::as_array).and_then(|paths| paths.first()).cloned() {
        normalized.insert("cwd".to_owned(), cwd);
    }
    if let Some(id) = input.get("conversationId").cloned() {
        normalized.insert("session_id".to_owned(), id);
    }
    let outcome = run_hook(event, &Value::Object(normalized).to_string(), state_dir, now);
    match event {
        HookEvent::SessionStart => {
            let context = serde_json::from_str::<Value>(&outcome.stdout)
                .ok()
                .and_then(|reply| reply["hookSpecificOutput"]["additionalContext"].as_str().map(str::to_owned));
            match context {
                Some(text) => HookOutcome {
                    stdout: json!({ "injectSteps": [{ "systemMessage": { "systemMessage": text } }] }).to_string(),
                    ..HookOutcome::default()
                },
                None => allow,
            }
        }
        HookEvent::Stop if outcome.exit_code == 2 => HookOutcome {
            stdout: json!({ "decision": "continue", "reason": outcome.stderr }).to_string(),
            ..HookOutcome::default()
        },
        HookEvent::Stop => allow,
    }
}

/// The nearest folder at or above `start` whose `.ai/INSTRUCTIONS.md` the app
/// wrote: it starts with the app's heading or carries the write-back marker.
/// Other `.ai/` folders, such as a home folder's shared AI rules, are not vaults.
pub fn find_vault_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| {
            fs::read_to_string(dir.join(INSTRUCTIONS)).is_ok_and(|text| {
                text.trim_start_matches('\u{feff}').starts_with("# Second Brain — INSTRUCTIONS")
                    || text.contains(WRITE_BACK_MARKER)
            })
        })
        .map(Path::to_path_buf)
}

fn session_file_name(id: &str) -> Option<String> {
    let cleaned: String = id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(80)
        .collect();
    (!cleaned.is_empty()).then(|| format!("{cleaned}.json"))
}

fn is_chinese_vault(vault: &Path) -> bool {
    fs::read_to_string(vault.join(INSTRUCTIONS))
        .map(|text| text.contains("做完要寫回") || text.contains("讀取順序"))
        .unwrap_or(false)
}

fn session_start(vault: &Path, session: Option<&str>, state_dir: &Path, now: SystemTime) -> HookOutcome {
    if let Some(name) = session {
        prune_old_states(state_dir, now);
        let counts: BTreeMap<String, usize> = markdown_files(vault)
            .into_iter()
            .filter_map(|(relative, path)| {
                let count = fs::read_to_string(&path).map(|text| count_worklogs(&text)).ok()?;
                (count > 0).then_some((relative, count))
            })
            .collect();
        let state = json!({
            "vault": vault.to_string_lossy(),
            "startedMs": millis(now),
            "counts": counts,
            "reminded": false,
        });
        let _ = fs::create_dir_all(state_dir);
        let _ = fs::write(state_dir.join(name), state.to_string());
    }
    let context = session_context(vault);
    if context.is_empty() {
        return HookOutcome::default();
    }
    HookOutcome {
        stdout: json!({
            "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": context }
        })
        .to_string(),
        ..HookOutcome::default()
    }
}

/// Today's P1 line and the recent-handoffs table from `.ai/INDEX.md`.
pub fn session_context(vault: &Path) -> String {
    let chinese = is_chinese_vault(vault);
    let index = fs::read_to_string(vault.join(INDEX)).unwrap_or_default();
    let p1 = index
        .lines()
        .find(|line| line.starts_with("今日最重要（P1）") || line.starts_with("Most important today (P1)"))
        .map(str::trim);
    let mut handoffs: Vec<&str> = Vec::new();
    let mut in_section = false;
    for line in index.lines() {
        if line.starts_with("## ") {
            in_section = line.starts_with("## Recent AI handoffs");
            continue;
        }
        if in_section && line.starts_with('|') && handoffs.len() < 7 {
            handoffs.push(line);
        }
    }
    // Name the folder: other instructions the AI has loaded may point at a
    // different second brain, and this session's tasks live here.
    let root = vault.to_string_lossy().replace('\\', "/");
    let mut out = String::new();
    if chinese {
        out.push_str(&format!(
            "這次工作的第二大腦（aizbrain vault）就是目前的資料夾 {root}，任務與筆記都在這裡。先讀 .ai/INSTRUCTIONS.md，再讀 .ai/INDEX.md。\n"
        ));
    } else {
        out.push_str(&format!(
            "The second brain (aizbrain vault) for this session is the current folder {root}; its tasks and notes are here. Read .ai/INSTRUCTIONS.md first, then .ai/INDEX.md.\n"
        ));
    }
    if let Some(line) = p1 {
        out.push_str(line);
        out.push('\n');
    }
    if handoffs.len() > 2 {
        out.push_str(if chinese { "最近 AI 交接：\n" } else { "Recent AI handoffs:\n" });
        for line in handoffs {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push_str(if chinese {
        "做完一件事，照 .ai/INSTRUCTIONS.md 的「做完要寫回」在任務下面加一段 AI 工作紀錄。"
    } else {
        "When you finish a piece of work, add an AI work log under the task as \"Write back when you finish\" in .ai/INSTRUCTIONS.md describes."
    });
    out
}

fn stop(input: &Value, vault: &Path, session: Option<&str>, state_dir: &Path, now: SystemTime) -> HookOutcome {
    // A turn already continued by this hook, or Grok's extra Stop at shutdown.
    if field_bool(input, "stop_hook_active", "stopHookActive") {
        return HookOutcome::default();
    }
    if matches!(field_str(input, "reason", "reason"), Some("shutdown" | "channel_closed")) {
        return HookOutcome::default();
    }
    let Some(name) = session else { return HookOutcome::default() };
    let path = state_dir.join(name);
    let Ok(text) = fs::read_to_string(&path) else { return HookOutcome::default() };
    let Ok(mut state) = serde_json::from_str::<Value>(&text) else { return HookOutcome::default() };
    if state.get("reminded").and_then(Value::as_bool) == Some(true) {
        return HookOutcome::default();
    }
    let Some(started) = state.get("startedMs").and_then(Value::as_u64) else {
        return HookOutcome::default();
    };
    let baseline = state.get("counts").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut changed = false;
    for (relative, file) in markdown_files(vault) {
        let modified = fs::metadata(&file)
            .and_then(|meta| meta.modified())
            .map(millis)
            .unwrap_or(0);
        if modified < started {
            continue;
        }
        changed = true;
        let before = baseline.get(&relative).and_then(Value::as_u64).unwrap_or(0) as usize;
        let after = fs::read_to_string(&file).map(|text| count_worklogs(&text)).unwrap_or(0);
        if after > before {
            return HookOutcome::default();
        }
    }
    if !changed {
        return HookOutcome::default();
    }
    if let Some(object) = state.as_object_mut() {
        object.insert("reminded".to_owned(), Value::Bool(true));
        object.insert("remindedMs".to_owned(), json!(millis(now)));
    }
    let _ = fs::write(&path, state.to_string());
    let reason = if is_chinese_vault(vault) {
        "這次有改到第二大腦的檔案，但還沒有寫 AI 工作紀錄。請照 .ai/INSTRUCTIONS.md 的「做完要寫回」，在對應任務下面加一段（做了什麼、結果在哪、下一步）；找不到任務就寫到 .ai/worklog/。已經不需要就簡短說明原因。"
    } else {
        "You changed files in this second brain but wrote no AI work log yet. Follow \"Write back when you finish\" in .ai/INSTRUCTIONS.md and add one under the matching task (done, result, next), or in .ai/worklog/ when no task matches. If none is needed, say why in one line."
    };
    HookOutcome {
        stderr: reason.to_owned(),
        exit_code: 2,
        ..HookOutcome::default()
    }
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map(|value| value.as_millis() as u64).unwrap_or(0)
}

fn prune_old_states(dir: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > STATE_MAX_AGE);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Count `### AI 工作紀錄 …` / `### AI work log …` headings.
pub fn count_worklogs(text: &str) -> usize {
    text.lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
            if !(2..=4).contains(&hashes) {
                return false;
            }
            let rest = trimmed[hashes..].trim_start();
            rest.starts_with("AI 工作紀錄") || rest.to_ascii_lowercase().starts_with("ai work log")
        })
        .count()
}

/// Vault Markdown that a work log can land in: content files and
/// `.ai/worklog/`. Skips other hidden or technical folders and `.ai/INDEX.md`.
fn markdown_files(vault: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut stack = vec![(vault.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if out.len() >= MAX_FILES {
                return out;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(vault) else { continue };
            let relative = relative.to_string_lossy().replace('\\', "/");
            let name = entry.file_name().to_string_lossy().to_string();
            if kind.is_dir() {
                let allowed = relative == ".ai" || relative == WORKLOG_DIR || relative.starts_with(&format!("{WORKLOG_DIR}/"));
                if depth < MAX_DEPTH && (allowed || (!name.starts_with('.') && name != "node_modules")) {
                    stack.push((path, depth + 1));
                }
            } else if kind.is_file()
                && name.to_ascii_lowercase().ends_with(".md")
                && (!relative.starts_with(".ai/") || relative.starts_with(&format!("{WORKLOG_DIR}/")))
            {
                out.push((relative, path));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// install / uninstall

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookTool {
    /// Claude Code `<vault>/.claude/settings.json`; Grok Build reads the same file.
    Claude,
    /// Codex `~/.codex/hooks.json`. Codex skipped project hook files in our
    /// tests, so this one is per user; the hook still acts only inside a vault.
    Codex,
    /// Gemini CLI `<vault>/.gemini/settings.json`.
    Gemini,
    /// Antigravity CLI, IDE and 2.0: `<vault>/.agents/hooks.json`, one named
    /// hook (`aizbrain`) per file.
    Antigravity,
}

/// The name of this binary's entry in an Antigravity `hooks.json`.
const ANTIGRAVITY_HOOK_NAME: &str = "aizbrain";

impl HookTool {
    pub fn parse(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "claude" | "claude-code" | "grok" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "gemini" | "gemini-cli" => Some(Self::Gemini),
            "antigravity" | "agy" => Some(Self::Antigravity),
            _ => None,
        }
    }

    fn events(self) -> [(&'static str, &'static str); 2] {
        match self {
            Self::Gemini => [("SessionStart", "session-start"), ("AfterAgent", "stop")],
            _ => [("SessionStart", "session-start"), ("Stop", "stop")],
        }
    }

    /// The settings file the tool reads.
    pub fn config_path(self, vault: &Path, home: &Path) -> PathBuf {
        match self {
            Self::Claude => vault.join(".claude").join("settings.json"),
            Self::Gemini => vault.join(".gemini").join("settings.json"),
            Self::Antigravity => vault.join(".agents").join("hooks.json"),
            Self::Codex => std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
                .join("hooks.json"),
        }
    }
}

/// The command a tool runs: the app binary with forward slashes, quoted only
/// when the path has spaces (PowerShell would read a quoted path as a string).
pub fn hook_command(exe: &Path, event: &str) -> String {
    let path = exe.to_string_lossy().replace('\\', "/");
    let program = if path.contains(' ') { format!("\"{path}\"") } else { path };
    format!("{program} {HOOK_FLAG} {event}")
}

fn is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command").and_then(Value::as_str).is_some_and(|command| command.contains(HOOK_FLAG))
            })
        })
}

/// Return `config` with this binary's entries added (install) or removed.
/// Everything else in the file is kept as it was.
pub fn apply_hook_entries(config: Value, tool: HookTool, exe: &Path, install: bool) -> Value {
    let mut root = match config {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if tool == HookTool::Antigravity {
        // Antigravity keys a file by hook name; events hold flat handler lists.
        root.remove(ANTIGRAVITY_HOOK_NAME);
        if install {
            let handler = |event: &str| json!([{ "type": "command", "command": format!("{} --format antigravity", hook_command(exe, event)) }]);
            root.insert(
                ANTIGRAVITY_HOOK_NAME.to_owned(),
                json!({ "SessionStart": handler("session-start"), "Stop": handler("stop") }),
            );
        }
        return Value::Object(root);
    }
    let mut hooks = match root.remove("hooks") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    for (event, command) in tool.events() {
        let mut entries: Vec<Value> = match hooks.remove(event) {
            Some(Value::Array(items)) => items.into_iter().filter(|entry| !is_ours(entry)).collect(),
            _ => Vec::new(),
        };
        if install {
            let mut entry = json!({ "hooks": [{ "type": "command", "command": hook_command(exe, command) }] });
            if tool == HookTool::Gemini {
                entry["matcher"] = json!("*");
            }
            entries.push(entry);
        }
        if !entries.is_empty() {
            hooks.insert(event.to_owned(), Value::Array(entries));
        }
    }
    if !hooks.is_empty() {
        root.insert("hooks".to_owned(), Value::Object(hooks));
    }
    if install && tool == HookTool::Gemini {
        let config = root.entry("hooksConfig").or_insert_with(|| json!({}));
        if let Some(object) = config.as_object_mut() {
            object.entry("enabled").or_insert(Value::Bool(true));
        }
    }
    Value::Object(root)
}

/// Install or remove the hook in one tool's settings file. An existing file is
/// copied to `<file>.aizbrain-backup` first; a file that is not valid JSON is
/// left untouched.
pub fn update_hook_config(path: &Path, tool: HookTool, exe: &Path, install: bool) -> Result<(), String> {
    let existing = match fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let config = match existing.as_deref().map(|text| text.trim_start_matches('\u{feff}')) {
        Some(text) if !text.trim().is_empty() => {
            serde_json::from_str(text).map_err(|_| format!("{} is not valid JSON; left unchanged", path.display()))?
        }
        _ => Value::Object(Map::new()),
    };
    if existing.is_none() && !install {
        return Ok(());
    }
    let updated = apply_hook_entries(config, tool, exe, install);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    }
    if existing.is_some() {
        let mut backup = path.as_os_str().to_owned();
        backup.push(".aizbrain-backup");
        fs::copy(path, PathBuf::from(backup)).map_err(|error| format!("cannot back up {}: {error}", path.display()))?;
    }
    let mut text = serde_json::to_string_pretty(&updated).map_err(|error| error.to_string())?;
    text.push('\n');
    let mut temp = path.as_os_str().to_owned();
    temp.push(".aizbrain-tmp");
    let temp = PathBuf::from(temp);
    fs::write(&temp, text).map_err(|error| format!("cannot write {}: {error}", temp.display()))?;
    fs::rename(&temp, path).map_err(|error| format!("cannot replace {}: {error}", path.display()))
}

fn run_install_command(install: bool, args: &[String]) -> HookOutcome {
    let fail = |message: String| HookOutcome { stderr: message, exit_code: 1, ..HookOutcome::default() };
    let (Some(tool), Some(vault)) = (args.first().and_then(|name| HookTool::parse(name)), args.get(1)) else {
        return fail(format!("usage: {HOOK_FLAG} install|uninstall claude|codex|gemini|antigravity <vault folder>"));
    };
    let vault = PathBuf::from(vault);
    if find_vault_root(&vault).as_deref() != Some(vault.as_path()) {
        return fail(format!("{} has no aizbrain {INSTRUCTIONS}; build the AI handoff architecture first\n", vault.display()));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
    let Ok(exe) = std::env::current_exe() else { return fail("cannot locate the app binary".to_owned()) };
    let path = tool.config_path(&vault, &home);
    match update_hook_config(&path, tool, &exe, install) {
        Ok(()) => HookOutcome {
            stdout: format!("{} {}\n", if install { "installed" } else { "removed" }, path.display()),
            ..HookOutcome::default()
        },
        Err(message) => fail(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(chinese: bool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".ai")).unwrap();
        fs::create_dir_all(root.join("收件匣")).unwrap();
        let instructions = if chinese {
            "# Second Brain — INSTRUCTIONS（正本 / Canonical）\n\n## 做完要寫回（Write back）\n"
        } else {
            "# My own rules\n\n<!-- aizbrain:write-back v1 -->\n## Write back when you finish\n"
        };
        fs::write(root.join(INSTRUCTIONS), instructions).unwrap();
        fs::write(
            root.join(INDEX),
            "# Index\n\n## Today's tasks 今日任務（2026-10-25）\n\n今日最重要（P1）：整理法說會重點\n\n## Recent AI handoffs 最近 AI 交接\n\n| 時間 | 工具 | 任務 | 下一步 | 路徑 |\n| --- | --- | --- | --- | --- |\n| 2026-10-24 21:10 | Claude Code | 整理法說會重點 | 追 AI 伺服器需求 | 收件匣/待辦.md |\n\n## Unscheduled ideas\n",
        )
        .unwrap();
        fs::write(root.join("收件匣/待辦.md"), "- [ ] #task 整理法說會重點\n").unwrap();
        dir
    }

    fn input(root: &Path, extra: Value) -> String {
        let mut value = json!({ "session_id": "s-1", "cwd": root.join("收件匣").to_string_lossy() });
        if let (Some(target), Some(source)) = (value.as_object_mut(), extra.as_object()) {
            for (key, item) in source {
                target.insert(key.clone(), item.clone());
            }
        }
        value.to_string()
    }

    fn later(start: SystemTime) -> SystemTime {
        start + Duration::from_secs(5)
    }

    #[test]
    fn outside_a_vault_the_hook_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        // Shared AI rules in a `.ai/` folder the app did not write.
        fs::create_dir_all(dir.path().join(".ai")).unwrap();
        fs::write(dir.path().join(INSTRUCTIONS), "# Shared rules\n").unwrap();
        let raw = json!({ "session_id": "s", "cwd": dir.path().to_string_lossy() }).to_string();
        assert_eq!(run_hook(HookEvent::SessionStart, &raw, state.path(), SystemTime::now()), HookOutcome::default());
        assert_eq!(run_hook(HookEvent::Stop, &raw, state.path(), SystemTime::now()), HookOutcome::default());
        assert_eq!(run_hook(HookEvent::Stop, "not json", state.path(), SystemTime::now()).exit_code, 0);
    }

    #[test]
    fn session_start_hands_the_ai_todays_p1_and_recent_handoffs() {
        let vault = vault(true);
        let state = tempfile::tempdir().unwrap();
        let out = run_hook(HookEvent::SessionStart, &input(vault.path(), json!({})), state.path(), SystemTime::now());
        let reply: Value = serde_json::from_str(&out.stdout).unwrap();
        let context = reply["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
        assert_eq!(reply["hookSpecificOutput"]["hookEventName"], "SessionStart");
        assert!(context.contains("今日最重要（P1）：整理法說會重點"));
        assert!(context.contains("| 2026-10-24 21:10 | Claude Code |"));
        assert!(context.contains("做完要寫回"));
        assert!(state.path().join("s-1.json").is_file());
    }

    #[test]
    fn a_question_only_turn_is_not_interrupted() {
        let vault = vault(true);
        let state = tempfile::tempdir().unwrap();
        let start = SystemTime::now() + Duration::from_secs(60);
        run_hook(HookEvent::SessionStart, &input(vault.path(), json!({})), state.path(), start);
        let out = run_hook(HookEvent::Stop, &input(vault.path(), json!({ "stop_hook_active": false })), state.path(), later(start));
        assert_eq!(out, HookOutcome::default());
    }

    #[test]
    fn a_turn_that_edits_the_vault_without_a_work_log_is_asked_once() {
        let vault = vault(true);
        let state = tempfile::tempdir().unwrap();
        let start = SystemTime::now() - Duration::from_secs(60);
        run_hook(HookEvent::SessionStart, &input(vault.path(), json!({})), state.path(), start);
        fs::write(vault.path().join("收件匣/待辦.md"), "- [x] #task 整理法說會重點\n").unwrap();
        let out = run_hook(HookEvent::Stop, &input(vault.path(), json!({})), state.path(), later(start));
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("AI 工作紀錄"));
        // The continued turn, and any later stop in the session, pass.
        let again = run_hook(HookEvent::Stop, &input(vault.path(), json!({ "stopHookActive": true })), state.path(), later(start));
        assert_eq!(again.exit_code, 0);
        let later_stop = run_hook(HookEvent::Stop, &input(vault.path(), json!({})), state.path(), later(start));
        assert_eq!(later_stop.exit_code, 0);
    }

    #[test]
    fn a_new_work_log_lets_the_turn_end() {
        let vault = vault(false);
        let state = tempfile::tempdir().unwrap();
        let start = SystemTime::now() - Duration::from_secs(60);
        fs::write(vault.path().join("收件匣/待辦.md"), "- [ ] #task A\n\n  ### AI work log 2026-10-24 09:00 (Codex)\n").unwrap();
        run_hook(HookEvent::SessionStart, &input(vault.path(), json!({})), state.path(), start);
        fs::write(
            vault.path().join("收件匣/待辦.md"),
            "- [x] #task A\n\n  ### AI work log 2026-10-24 09:00 (Codex)\n\n  ### AI work log 2026-10-25 10:42 (Claude Code)\n  - Next: x\n",
        )
        .unwrap();
        let out = run_hook(HookEvent::Stop, &input(vault.path(), json!({})), state.path(), later(start));
        assert_eq!(out, HookOutcome::default());
    }

    #[test]
    fn a_log_in_the_worklog_folder_counts_and_grok_shutdown_stops_pass() {
        let vault = vault(false);
        let state = tempfile::tempdir().unwrap();
        let start = SystemTime::now() - Duration::from_secs(60);
        run_hook(HookEvent::SessionStart, &input(vault.path(), json!({})), state.path(), start);
        fs::write(vault.path().join("收件匣/待辦.md"), "- [x] #task 整理法說會重點\n").unwrap();
        let shutdown = run_hook(HookEvent::Stop, &input(vault.path(), json!({ "reason": "shutdown" })), state.path(), later(start));
        assert_eq!(shutdown.exit_code, 0);
        fs::create_dir_all(vault.path().join(WORKLOG_DIR)).unwrap();
        fs::write(vault.path().join(WORKLOG_DIR).join("2026-10.md"), "### AI work log 2026-10-25 10:42 (Gemini CLI)\n").unwrap();
        let out = run_hook(HookEvent::Stop, &input(vault.path(), json!({})), state.path(), later(start));
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn work_log_headings_are_counted_in_both_languages() {
        let text = "### AI 工作紀錄 2026-10-25 10:42（Codex）\n  #### ai work log 2026-10-25 (x)\n# AI work log too shallow\n##### AI work log too deep\nAI 工作紀錄 not a heading\n";
        assert_eq!(count_worklogs(text), 2);
    }

    #[test]
    fn install_adds_only_our_entries_and_uninstall_removes_only_them() {
        let exe = Path::new(r"C:\Users\me\AppData\Local\aizbrain\second-brain-workspace.exe");
        let existing = json!({
            "permissions": { "allow": ["Bash(ls)"] },
            "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "my-linter" }] }] }
        });
        let installed = apply_hook_entries(existing.clone(), HookTool::Claude, exe, true);
        assert_eq!(installed["permissions"], existing["permissions"]);
        let stops = installed["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stops.len(), 2);
        assert_eq!(stops[0]["hooks"][0]["command"], "my-linter");
        assert_eq!(
            stops[1]["hooks"][0]["command"],
            "C:/Users/me/AppData/Local/aizbrain/second-brain-workspace.exe --aizbrain-hook stop"
        );
        assert_eq!(
            installed["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "C:/Users/me/AppData/Local/aizbrain/second-brain-workspace.exe --aizbrain-hook session-start"
        );
        // Installing twice does not duplicate.
        let twice = apply_hook_entries(installed.clone(), HookTool::Claude, exe, true);
        assert_eq!(twice, installed);
        let removed = apply_hook_entries(installed, HookTool::Claude, exe, false);
        assert_eq!(removed, existing);
    }

    #[test]
    fn gemini_uses_after_agent_and_enables_hooks_without_overriding_a_choice() {
        let exe = Path::new("C:/a/aizbrain.exe");
        let installed = apply_hook_entries(json!({}), HookTool::Gemini, exe, true);
        assert_eq!(installed["hooks"]["AfterAgent"][0]["matcher"], "*");
        assert_eq!(installed["hooks"]["AfterAgent"][0]["hooks"][0]["command"], "C:/a/aizbrain.exe --aizbrain-hook stop");
        assert_eq!(installed["hooksConfig"]["enabled"], true);
        let kept = apply_hook_entries(json!({ "hooksConfig": { "enabled": false } }), HookTool::Gemini, exe, true);
        assert_eq!(kept["hooksConfig"]["enabled"], false);
    }

    fn antigravity_input(root: &Path, extra: Value) -> String {
        let mut value = json!({ "conversationId": "conv-1", "workspacePaths": [root.to_string_lossy()], "modelName": "auto" });
        if let (Some(target), Some(source)) = (value.as_object_mut(), extra.as_object()) {
            for (key, item) in source {
                target.insert(key.clone(), item.clone());
            }
        }
        value.to_string()
    }

    #[test]
    fn antigravity_gets_context_as_injected_steps_and_continue_to_write_back() {
        let vault = vault(true);
        let state = tempfile::tempdir().unwrap();
        let start = SystemTime::now() - Duration::from_secs(60);
        let opened = run_antigravity_hook(HookEvent::SessionStart, &antigravity_input(vault.path(), json!({})), state.path(), start);
        let reply: Value = serde_json::from_str(&opened.stdout).unwrap();
        assert!(reply["injectSteps"][0]["systemMessage"]["systemMessage"]
            .as_str()
            .unwrap()
            .contains("今日最重要（P1）：整理法說會重點"));
        fs::write(vault.path().join("收件匣/待辦.md"), "- [x] #task 整理法說會重點\n").unwrap();
        // A cancelled or failed turn is never held back.
        let cancelled = run_antigravity_hook(HookEvent::Stop, &antigravity_input(vault.path(), json!({ "terminationReason": "USER_CANCELED" })), state.path(), later(start));
        assert_eq!(cancelled.stdout, "{}");
        let held = run_antigravity_hook(HookEvent::Stop, &antigravity_input(vault.path(), json!({ "terminationReason": "NO_TOOL_CALL" })), state.path(), later(start));
        assert_eq!(held.exit_code, 0);
        let reply: Value = serde_json::from_str(&held.stdout).unwrap();
        assert_eq!(reply["decision"], "continue");
        assert!(reply["reason"].as_str().unwrap().contains("AI 工作紀錄"));
        let next = run_antigravity_hook(HookEvent::Stop, &antigravity_input(vault.path(), json!({ "terminationReason": "NO_TOOL_CALL" })), state.path(), later(start));
        assert_eq!(next.stdout, "{}");
        let outside = tempfile::tempdir().unwrap();
        assert_eq!(run_antigravity_hook(HookEvent::Stop, &antigravity_input(outside.path(), json!({})), state.path(), later(start)).stdout, "{}");
    }

    #[test]
    fn antigravity_install_owns_one_named_hook() {
        let exe = Path::new("C:/a/aizbrain.exe");
        let existing = json!({ "lint-checker": { "PostToolUse": [] } });
        let installed = apply_hook_entries(existing.clone(), HookTool::Antigravity, exe, true);
        assert_eq!(installed["lint-checker"], existing["lint-checker"]);
        assert_eq!(installed["aizbrain"]["SessionStart"][0]["command"], "C:/a/aizbrain.exe --aizbrain-hook session-start --format antigravity");
        assert_eq!(installed["aizbrain"]["Stop"][0]["command"], "C:/a/aizbrain.exe --aizbrain-hook stop --format antigravity");
        assert_eq!(apply_hook_entries(installed, HookTool::Antigravity, exe, false), existing);
    }

    #[test]
    fn a_path_with_spaces_is_quoted() {
        assert_eq!(
            hook_command(Path::new(r"C:\Program Files\aizbrain\aizbrain.exe"), "stop"),
            "\"C:/Program Files/aizbrain/aizbrain.exe\" --aizbrain-hook stop"
        );
    }

    #[test]
    fn the_config_file_is_backed_up_and_invalid_json_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude").join("settings.json");
        let exe = Path::new("C:/a/aizbrain.exe");
        update_hook_config(&path, HookTool::Claude, exe, true).unwrap();
        assert!(!dir.path().join(".claude/settings.json.aizbrain-backup").exists());
        update_hook_config(&path, HookTool::Claude, exe, false).unwrap();
        assert!(dir.path().join(".claude/settings.json.aizbrain-backup").is_file());
        let left: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(left, json!({}));
        fs::write(&path, "{ not json").unwrap();
        assert!(update_hook_config(&path, HookTool::Claude, exe, true).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
