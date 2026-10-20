//! Retention policy for the verified ZIP backups created by `BackupManager`.
//!
//! Selection is a pure function over `(file name, created-at, paths)` entries
//! so the policy can be tested without touching the file system. Each archive
//! only holds the files touched by one write batch, so the daily and weekly
//! tiers are evaluated per file: an archive survives when it is the newest one
//! in its bucket for at least one relative path it contains. Directory pruning
//! only removes regular files whose names match the pattern produced by
//! `BackupManager::unique_path` (`backup-<unix ms>-<32 hex uuid>.zip`).
//!
//! Calendar days and ISO weeks are computed in UTC; the native layer has no
//! time-zone dependency and the policy only needs stable buckets.

use crate::backup::BackupManager;
use crate::error::NativeError;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const DAY_MS: i64 = 86_400_000;
/// The newest backups that are always kept, whatever their age.
pub const KEEP_NEWEST: usize = 50;
/// Every backup younger than this is kept.
pub const KEEP_ALL_DAYS: i64 = 7;
/// Up to this age, the newest backup of each file per UTC calendar day is kept.
pub const KEEP_DAILY_DAYS: i64 = 30;
/// Up to this age, the newest backup of each file per ISO week is kept.
pub const KEEP_WEEKLY_DAYS: i64 = 90;
/// Minimum delay between two prune passes for the same vault.
pub const PRUNE_INTERVAL: Duration = Duration::from_secs(10 * 60);

const BACKUP_PREFIX: &str = "backup-";
const BACKUP_SUFFIX: &str = ".zip";
const BACKUP_ID_HEX_LEN: usize = 32;
const MAX_TIMESTAMP_DIGITS: usize = 18;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupEntry {
    pub name: String,
    pub created_at_ms: i64,
    /// Relative paths stored in the archive, or `None` when they could not be
    /// read. Unknown archives in the daily and weekly tiers are always kept
    /// and never make another archive redundant. Ignored outside those tiers.
    pub paths: Option<Vec<String>>,
}

#[derive(Debug, Default)]
pub struct PruneOutcome {
    pub deleted: Vec<PathBuf>,
    pub failed: usize,
}

/// Returns the creation timestamp encoded in a backup file name, or `None`
/// when the name was not produced by `BackupManager`.
pub fn parse_backup_file_name(name: &str) -> Option<i64> {
    let rest = name
        .strip_prefix(BACKUP_PREFIX)?
        .strip_suffix(BACKUP_SUFFIX)?;
    let (millis, id) = rest.split_once('-')?;
    let millis_valid = !millis.is_empty()
        && millis.len() <= MAX_TIMESTAMP_DIGITS
        && millis.bytes().all(|byte| byte.is_ascii_digit());
    let id_valid = id.len() == BACKUP_ID_HEX_LEN
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    if !millis_valid || !id_valid {
        return None;
    }
    millis.parse().ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Tier {
    KeepAll,
    Daily,
    Weekly,
    Expired,
}

fn tier_for(created_at_ms: i64, now_ms: i64) -> Tier {
    let age_ms = now_ms.saturating_sub(created_at_ms);
    if age_ms < KEEP_ALL_DAYS * DAY_MS {
        Tier::KeepAll
    } else if age_ms < KEEP_DAILY_DAYS * DAY_MS {
        Tier::Daily
    } else if age_ms < KEEP_WEEKLY_DAYS * DAY_MS {
        Tier::Weekly
    } else {
        Tier::Expired
    }
}

/// True when the policy needs the archive's path list to decide its fate,
/// i.e. it falls in the daily or weekly tier.
pub fn needs_paths(created_at_ms: i64, now_ms: i64) -> bool {
    matches!(tier_for(created_at_ms, now_ms), Tier::Daily | Tier::Weekly)
}

/// Selects the backups that the retention policy allows to delete.
///
/// Kept: the newest `KEEP_NEWEST`; everything younger than `KEEP_ALL_DAYS`
/// (including timestamps in the future); among backups aged
/// `KEEP_ALL_DAYS..KEEP_DAILY_DAYS`, every archive that is the newest in its
/// UTC day for at least one path it contains; the same per ISO week among
/// backups aged `KEEP_DAILY_DAYS..KEEP_WEEKLY_DAYS`; and every daily or
/// weekly archive whose paths are unknown. Buckets are evaluated per tier, so
/// a day or week that straddles a tier boundary keeps extra backups rather
/// than fewer.
pub fn select_backups_to_prune(entries: &[BackupEntry], now_ms: i64) -> HashSet<String> {
    let mut newest_first = entries.iter().collect::<Vec<_>>();
    newest_first.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| right.name.cmp(&left.name))
    });
    // Paths already covered by a newer archive in the same (tier, bucket).
    let mut covered: HashMap<(Tier, i64), HashSet<&str>> = HashMap::new();
    let mut prune = HashSet::new();
    for (rank, entry) in newest_first.into_iter().enumerate() {
        let tier = tier_for(entry.created_at_ms, now_ms);
        let kept_by_age = match tier {
            Tier::KeepAll => true,
            Tier::Expired => false,
            Tier::Daily | Tier::Weekly => {
                let bucket = if tier == Tier::Daily {
                    day_index(entry.created_at_ms)
                } else {
                    iso_week_index(entry.created_at_ms)
                };
                match &entry.paths {
                    None => true,
                    Some(paths) => {
                        let seen = covered.entry((tier, bucket)).or_default();
                        // Evaluate every path so all of them become covered.
                        paths.iter().fold(false, |is_newest, path| {
                            seen.insert(path.as_str()) || is_newest
                        })
                    }
                }
            }
        };
        if !kept_by_age && rank >= KEEP_NEWEST {
            prune.insert(entry.name.clone());
        }
    }
    prune
}

fn day_index(unix_ms: i64) -> i64 {
    unix_ms.div_euclid(DAY_MS)
}

/// Monday-aligned week number. 1970-01-01 was a Thursday, so shifting by
/// three days makes every bucket run Monday..Sunday like ISO 8601 weeks.
fn iso_week_index(unix_ms: i64) -> i64 {
    (day_index(unix_ms) + 3).div_euclid(7)
}

/// Applies the retention policy to one vault's backup directory.
///
/// `protected` holds file names that must survive regardless of policy, such
/// as the archive that was just created and archives referenced by recovery
/// journals. Symlinks, reparse points and unrecognised names are never
/// touched. Manifests are read only for archives in the daily and weekly
/// tiers; an archive whose manifest cannot be read is kept. Individual delete
/// failures are counted, not returned.
pub fn prune_backup_dir(
    backup_dir: &Path,
    protected: &HashSet<String>,
    now_ms: i64,
) -> Result<PruneOutcome, NativeError> {
    let dir_metadata = fs::symlink_metadata(backup_dir)?;
    if !dir_metadata.is_dir() || is_link_or_reparse(&dir_metadata) {
        return Err(NativeError::UnsafePath);
    }
    let mut entries = Vec::new();
    for item in fs::read_dir(backup_dir)? {
        let item = item?;
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(created_at_ms) = parse_backup_file_name(&name) else {
            continue;
        };
        let path = item.path();
        if !is_regular_backup_file(&path) {
            continue;
        }
        let paths = needs_paths(created_at_ms, now_ms)
            .then(|| BackupManager::read_manifest_paths(&path).ok())
            .flatten();
        entries.push(BackupEntry {
            name,
            created_at_ms,
            paths,
        });
    }

    let mut outcome = PruneOutcome::default();
    let mut selected = select_backups_to_prune(&entries, now_ms)
        .into_iter()
        .filter(|name| !protected.contains(name))
        .collect::<Vec<_>>();
    selected.sort();
    for name in selected {
        let path = backup_dir.join(&name);
        // Re-check right before deleting so a file swapped for a link after
        // listing is left alone.
        if !is_regular_backup_file(&path) {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => outcome.deleted.push(path),
            Err(_) => outcome.failed += 1,
        }
    }
    Ok(outcome)
}

fn is_regular_backup_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file() && !is_link_or_reparse(&metadata))
        .unwrap_or(false)
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Cheap in-memory throttle so pruning runs at most once per interval per
/// vault. State is lost on restart, which only means one extra early pass.
pub struct PruneThrottle {
    interval: Duration,
    last_run: Mutex<HashMap<String, Instant>>,
}

impl PruneThrottle {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            last_run: Mutex::new(HashMap::new()),
        }
    }

    /// Returns true and records `now` when a prune pass may start.
    pub fn try_begin(&self, vault_id: &str, now: Instant) -> bool {
        let Ok(mut last_run) = self.last_run.lock() else {
            return false;
        };
        let due = last_run.get(vault_id).map_or(true, |last| {
            now.saturating_duration_since(*last) >= self.interval
        });
        if due {
            last_run.insert(vault_id.to_owned(), now);
        }
        due
    }
}

pub fn global_throttle() -> &'static PruneThrottle {
    static THROTTLE: OnceLock<PruneThrottle> = OnceLock::new();
    THROTTLE.get_or_init(|| PruneThrottle::new(PRUNE_INTERVAL))
}

pub fn file_name_of(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR_MS: i64 = 3_600_000;
    // 2026-10-20T12:00:00Z, a Tuesday.
    const NOW: i64 = 1_792_497_600_000;

    fn name_for(created_at_ms: i64, seq: u32) -> String {
        format!("backup-{created_at_ms}-{seq:032x}.zip")
    }

    /// An archive holding the single shared path `note.md`, which reduces
    /// the per-file tiers to "newest archive per bucket".
    fn entry(created_at_ms: i64, seq: u32) -> BackupEntry {
        entry_with(created_at_ms, seq, &["note.md"])
    }

    fn entry_with(created_at_ms: i64, seq: u32, paths: &[&str]) -> BackupEntry {
        BackupEntry {
            name: name_for(created_at_ms, seq),
            created_at_ms,
            paths: Some(paths.iter().map(|path| (*path).to_owned()).collect()),
        }
    }

    fn unreadable(created_at_ms: i64, seq: u32) -> BackupEntry {
        BackupEntry {
            name: name_for(created_at_ms, seq),
            created_at_ms,
            paths: None,
        }
    }

    fn monday_six_weeks_ago() -> i64 {
        let day = day_index(NOW) - 42;
        (day - (day + 3).rem_euclid(7)) * DAY_MS
    }

    /// Pads the list with `KEEP_NEWEST` brand-new backups so the
    /// keep-newest rule does not mask the age tiers under test.
    fn with_recent_padding(mut entries: Vec<BackupEntry>) -> Vec<BackupEntry> {
        for index in 0..KEEP_NEWEST as u32 {
            entries.push(entry(NOW - i64::from(index) * 1_000, 10_000 + index));
        }
        entries
    }

    #[test]
    fn now_constant_is_a_tuesday_noon_utc() {
        assert_eq!(NOW % DAY_MS, 12 * HOUR_MS);
        // Monday-based weekday: 0 = Monday.
        assert_eq!((day_index(NOW) + 3).rem_euclid(7), 1);
    }

    #[test]
    fn parses_names_produced_by_backup_manager() {
        let name = format!("backup-1792497600000-{}.zip", uuid::Uuid::new_v4().simple());
        assert_eq!(parse_backup_file_name(&name), Some(1_792_497_600_000));
    }

    #[test]
    fn rejects_names_not_produced_by_backup_manager() {
        let id = "0123456789abcdef0123456789abcdef";
        for name in [
            format!("backup-123-{id}.zip.tmp"),
            format!("backup--{id}.zip"),
            format!("backup-12a-{id}.zip"),
            format!("backup-123-{}.zip", &id[..31]),
            format!("backup-123-{}.zip", id.to_uppercase()),
            format!("Backup-123-{id}.zip"),
            format!("backup-123-{id}.ZIP"),
            format!("backup-1234567890123456789-{id}.zip"),
            format!("backup-123-{id}-x.zip"),
            "manifest.json".to_owned(),
            "backup.zip".to_owned(),
            String::new(),
        ] {
            assert_eq!(parse_backup_file_name(&name), None, "{name}");
        }
    }

    #[test]
    fn empty_list_prunes_nothing() {
        assert!(select_backups_to_prune(&[], NOW).is_empty());
    }

    #[test]
    fn always_keeps_the_newest_fifty_even_when_ancient() {
        let ancient = (0..60)
            .map(|index| entry(NOW - 400 * DAY_MS - i64::from(index) * HOUR_MS, index))
            .collect::<Vec<_>>();
        let pruned = select_backups_to_prune(&ancient, NOW);
        assert_eq!(pruned.len(), 10);
        assert!(ancient[..50]
            .iter()
            .all(|kept| !pruned.contains(&kept.name)));
        assert!(ancient[50..].iter().all(|gone| pruned.contains(&gone.name)));
    }

    #[test]
    fn fewer_than_fifty_backups_are_never_pruned() {
        let entries = (0..KEEP_NEWEST as u32)
            .map(|index| entry(NOW - 365 * DAY_MS * i64::from(index + 1), index))
            .collect::<Vec<_>>();
        assert!(select_backups_to_prune(&entries, NOW).is_empty());
    }

    #[test]
    fn keep_newest_ranks_by_timestamp_not_input_order() {
        let mut entries = (0..51)
            .map(|index| entry(NOW - 200 * DAY_MS - i64::from(index) * HOUR_MS, index))
            .collect::<Vec<_>>();
        entries.reverse();
        let pruned = select_backups_to_prune(&entries, NOW);
        assert_eq!(
            pruned,
            HashSet::from([name_for(NOW - 200 * DAY_MS - 50 * HOUR_MS, 50)])
        );
    }

    #[test]
    fn keeps_everything_within_seven_days() {
        let mut entries = Vec::new();
        for index in 0..200 {
            entries.push(entry(
                NOW - 7 * DAY_MS + 1 + i64::from(index) * HOUR_MS / 2,
                index,
            ));
        }
        assert!(select_backups_to_prune(&entries, NOW).is_empty());
    }

    #[test]
    fn exactly_seven_days_old_falls_into_the_daily_tier() {
        let boundary = NOW - 7 * DAY_MS;
        let older_same_day = boundary - HOUR_MS;
        let entries = with_recent_padding(vec![entry(boundary, 1), entry(older_same_day, 2)]);
        let pruned = select_backups_to_prune(&entries, NOW);
        // Both sit on the same UTC day (11:00 and 12:00); keep the newer one.
        assert_eq!(pruned, HashSet::from([name_for(older_same_day, 2)]));
    }

    #[test]
    fn keeps_newest_per_utc_day_between_seven_and_thirty_days() {
        let day_start = (day_index(NOW) - 10) * DAY_MS;
        let entries = with_recent_padding(vec![
            entry(day_start, 1),
            entry(day_start + 12 * HOUR_MS, 2),
            entry(day_start + DAY_MS - 1, 3),
            entry(day_start + DAY_MS, 4),
        ]);
        let pruned = select_backups_to_prune(&entries, NOW);
        assert_eq!(
            pruned,
            HashSet::from([
                name_for(day_start, 1),
                name_for(day_start + 12 * HOUR_MS, 2)
            ])
        );
    }

    #[test]
    fn a_day_straddling_the_seven_day_boundary_keeps_one_extra() {
        let boundary = NOW - 7 * DAY_MS;
        let entries = with_recent_padding(vec![
            entry(boundary + HOUR_MS, 1),
            entry(boundary - HOUR_MS, 2),
            entry(boundary - 2 * HOUR_MS, 3),
        ]);
        let pruned = select_backups_to_prune(&entries, NOW);
        assert_eq!(pruned, HashSet::from([name_for(boundary - 2 * HOUR_MS, 3)]));
    }

    #[test]
    fn exactly_thirty_days_old_falls_into_the_weekly_tier() {
        let boundary = NOW - 30 * DAY_MS;
        let just_inside = boundary + 1;
        let entries = with_recent_padding(vec![entry(just_inside, 1), entry(boundary, 2)]);
        // Same UTC day, but tier-local buckets keep the newest of each tier.
        assert!(select_backups_to_prune(&entries, NOW).is_empty());
    }

    #[test]
    fn keeps_newest_per_iso_week_between_thirty_and_ninety_days() {
        // Monday 00:00 UTC of the week ~6 weeks ago.
        let monday = monday_six_weeks_ago();
        let sunday_last_ms = monday + 7 * DAY_MS - 1;
        let next_monday = monday + 7 * DAY_MS;
        let entries = with_recent_padding(vec![
            entry(monday, 1),
            entry(monday + 3 * DAY_MS, 2),
            entry(sunday_last_ms, 3),
            entry(next_monday, 4),
            entry(next_monday + DAY_MS, 5),
        ]);
        let pruned = select_backups_to_prune(&entries, NOW);
        assert_eq!(
            pruned,
            HashSet::from([
                name_for(monday, 1),
                name_for(monday + 3 * DAY_MS, 2),
                name_for(next_monday, 4),
            ])
        );
    }

    #[test]
    fn daily_tier_keeps_the_newest_version_of_each_file() {
        // Day 10: 09:00 touched note X, 18:00 touched only the inbox.
        let day_start = (day_index(NOW) - 10) * DAY_MS;
        let early_x = entry_with(day_start + 8 * HOUR_MS, 1, &["notes/x.md"]);
        let x = entry_with(day_start + 9 * HOUR_MS, 2, &["notes/x.md"]);
        let inbox = entry_with(day_start + 18 * HOUR_MS, 3, &["inbox.md"]);
        let entries = with_recent_padding(vec![early_x.clone(), x.clone(), inbox.clone()]);
        let pruned = select_backups_to_prune(&entries, NOW);
        assert_eq!(pruned, HashSet::from([early_x.name]));
    }

    #[test]
    fn an_archive_survives_when_any_of_its_paths_is_newest() {
        let day_start = (day_index(NOW) - 12) * DAY_MS;
        let entries = with_recent_padding(vec![
            entry_with(day_start + 20 * HOUR_MS, 1, &["a.md", "b.md"]),
            // `c.md` is newest here, so the archive stays despite a and b.
            entry_with(day_start + 15 * HOUR_MS, 2, &["a.md", "c.md"]),
            // Every path is covered by a newer archive the same day.
            entry_with(day_start + 10 * HOUR_MS, 3, &["b.md", "c.md"]),
            entry_with(day_start + 5 * HOUR_MS, 4, &["a.md", "b.md", "c.md"]),
            // An empty archive holds no file version.
            entry_with(day_start + HOUR_MS, 5, &[]),
        ]);
        let pruned = select_backups_to_prune(&entries, NOW);
        assert_eq!(
            pruned,
            HashSet::from([
                name_for(day_start + 10 * HOUR_MS, 3),
                name_for(day_start + 5 * HOUR_MS, 4),
                name_for(day_start + HOUR_MS, 5),
            ])
        );
    }

    #[test]
    fn coverage_does_not_leak_between_days() {
        let day_start = (day_index(NOW) - 15) * DAY_MS;
        let entries = with_recent_padding(vec![
            entry_with(day_start + DAY_MS + HOUR_MS, 1, &["x.md"]),
            entry_with(day_start + 23 * HOUR_MS, 2, &["x.md"]),
            entry_with(day_start + HOUR_MS, 3, &["x.md"]),
        ]);
        let pruned = select_backups_to_prune(&entries, NOW);
        assert_eq!(pruned, HashSet::from([name_for(day_start + HOUR_MS, 3)]));
    }

    #[test]
    fn unreadable_archives_are_kept_and_cover_nothing() {
        let day_start = (day_index(NOW) - 10) * DAY_MS;
        let entries = with_recent_padding(vec![
            // Newest of the day, but its paths are unknown.
            unreadable(day_start + 20 * HOUR_MS, 1),
            entry_with(day_start + 10 * HOUR_MS, 2, &["x.md"]),
            entry_with(day_start + 9 * HOUR_MS, 3, &["x.md"]),
            unreadable(day_start + 8 * HOUR_MS, 4),
        ]);
        let pruned = select_backups_to_prune(&entries, NOW);
        // The unknown archives survive, and the 20:00 one does not make the
        // 10:00 version of x.md look redundant.
        assert_eq!(
            pruned,
            HashSet::from([name_for(day_start + 9 * HOUR_MS, 3)])
        );
    }

    #[test]
    fn unreadable_archives_outside_the_bucketed_tiers_follow_age_rules() {
        let entries = with_recent_padding(vec![
            unreadable(NOW - 2 * DAY_MS, 1),
            unreadable(NOW - 120 * DAY_MS, 2),
        ]);
        let pruned = select_backups_to_prune(&entries, NOW);
        assert_eq!(pruned, HashSet::from([name_for(NOW - 120 * DAY_MS, 2)]));
    }

    #[test]
    fn weekly_tier_keeps_the_newest_version_of_each_file() {
        let monday = monday_six_weeks_ago();
        let entries = with_recent_padding(vec![
            entry_with(monday + HOUR_MS, 1, &["x.md"]),
            entry_with(monday + 2 * DAY_MS, 2, &["x.md", "inbox.md"]),
            entry_with(monday + 4 * DAY_MS, 3, &["inbox.md"]),
            entry_with(monday + 6 * DAY_MS, 4, &["inbox.md"]),
            entry_with(monday + 7 * DAY_MS, 5, &["inbox.md"]),
        ]);
        let pruned = select_backups_to_prune(&entries, NOW);
        // Wednesday keeps x.md; Sunday keeps inbox.md; next Monday is its own
        // week. Monday and Friday are fully covered within the week.
        assert_eq!(
            pruned,
            HashSet::from([
                name_for(monday + HOUR_MS, 1),
                name_for(monday + 4 * DAY_MS, 3),
            ])
        );
    }

    #[test]
    fn manifests_are_needed_only_for_daily_and_weekly_tiers() {
        assert!(!needs_paths(NOW, NOW));
        assert!(!needs_paths(NOW - 7 * DAY_MS + 1, NOW));
        assert!(needs_paths(NOW - 7 * DAY_MS, NOW));
        assert!(needs_paths(NOW - 30 * DAY_MS, NOW));
        assert!(needs_paths(NOW - 90 * DAY_MS + 1, NOW));
        assert!(!needs_paths(NOW - 90 * DAY_MS, NOW));
        assert!(!needs_paths(NOW + DAY_MS, NOW));
    }

    #[test]
    fn iso_week_buckets_start_on_monday() {
        // 1970-01-04 was a Sunday, 1970-01-05 a Monday.
        assert_eq!(iso_week_index(3 * DAY_MS), iso_week_index(0));
        assert_ne!(iso_week_index(4 * DAY_MS), iso_week_index(3 * DAY_MS));
        assert_eq!(
            iso_week_index(4 * DAY_MS),
            iso_week_index(10 * DAY_MS + DAY_MS - 1)
        );
        // Pre-epoch Monday 1969-12-29 shares the week with 1970-01-01.
        assert_eq!(iso_week_index(-3 * DAY_MS), iso_week_index(0));
        assert_ne!(iso_week_index(-3 * DAY_MS - 1), iso_week_index(0));
    }

    #[test]
    fn deletes_everything_ninety_days_and_older_beyond_the_newest_fifty() {
        let boundary = NOW - 90 * DAY_MS;
        let entries = with_recent_padding(vec![
            entry(boundary + 1, 1),
            entry(boundary, 2),
            entry(boundary - 30 * DAY_MS, 3),
        ]);
        let pruned = select_backups_to_prune(&entries, NOW);
        assert_eq!(
            pruned,
            HashSet::from([name_for(boundary, 2), name_for(boundary - 30 * DAY_MS, 3)])
        );
    }

    #[test]
    fn future_timestamps_are_kept() {
        let entries = with_recent_padding(vec![entry(NOW + 365 * DAY_MS, 1)]);
        assert!(select_backups_to_prune(&entries, NOW).is_empty());
    }

    #[test]
    fn realistic_history_keeps_bounded_count() {
        // One backup every 15 minutes for 200 days.
        let entries = (0..(200 * 96))
            .map(|index| entry(NOW - i64::from(index) * 15 * 60 * 1_000, index))
            .collect::<Vec<_>>();
        let pruned = select_backups_to_prune(&entries, NOW);
        let kept = entries.len() - pruned.len();
        // 7 days * 96, plus 23-24 daily buckets and 9-10 weekly buckets.
        assert!(kept > 7 * 96 + 23, "kept {kept}");
        assert!(kept <= 7 * 96 + 24 + 10, "kept {kept}");
    }

    #[test]
    fn prune_dir_deletes_only_selected_regular_backup_files() {
        let dir = tempfile::tempdir().unwrap();
        let old = name_for(NOW - 200 * DAY_MS, 1);
        let protected_old = name_for(NOW - 201 * DAY_MS, 2);
        fs::write(dir.path().join(&old), b"old").unwrap();
        fs::write(dir.path().join(&protected_old), b"journal").unwrap();
        fs::write(dir.path().join("notes.zip"), b"foreign").unwrap();
        fs::write(dir.path().join(format!("{old}.tmp")), b"tmp").unwrap();
        fs::create_dir(dir.path().join(name_for(NOW - 300 * DAY_MS, 3))).unwrap();
        for index in 0..KEEP_NEWEST as u32 {
            fs::write(
                dir.path()
                    .join(name_for(NOW - i64::from(index), 100 + index)),
                b"new",
            )
            .unwrap();
        }

        let protected = HashSet::from([protected_old.clone()]);
        let outcome = prune_backup_dir(dir.path(), &protected, NOW).unwrap();

        assert_eq!(outcome.deleted, vec![dir.path().join(&old)]);
        assert_eq!(outcome.failed, 0);
        assert!(!dir.path().join(&old).exists());
        assert!(dir.path().join(&protected_old).exists());
        assert!(dir.path().join("notes.zip").exists());
        assert!(dir.path().join(format!("{old}.tmp")).exists());
        assert!(dir.path().join(name_for(NOW - 300 * DAY_MS, 3)).is_dir());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), KEEP_NEWEST + 4);
    }

    #[test]
    fn prune_dir_rejects_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(prune_backup_dir(&dir.path().join("missing"), &HashSet::new(), NOW).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn prune_dir_never_follows_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("victim.zip");
        fs::write(&target, b"victim").unwrap();
        let link = dir.path().join(name_for(NOW - 400 * DAY_MS, 1));
        std::os::unix::fs::symlink(&target, &link).unwrap();
        for index in 0..KEEP_NEWEST as u32 {
            fs::write(
                dir.path()
                    .join(name_for(NOW - i64::from(index), 100 + index)),
                b"new",
            )
            .unwrap();
        }
        let outcome = prune_backup_dir(dir.path(), &HashSet::new(), NOW).unwrap();
        assert!(outcome.deleted.is_empty());
        assert!(target.exists());
    }

    #[test]
    fn throttle_allows_one_pass_per_interval_per_vault() {
        let throttle = PruneThrottle::new(Duration::from_secs(600));
        let start = Instant::now();
        assert!(throttle.try_begin("vault-a", start));
        assert!(!throttle.try_begin("vault-a", start + Duration::from_secs(599)));
        assert!(throttle.try_begin("vault-b", start + Duration::from_secs(1)));
        assert!(throttle.try_begin("vault-a", start + Duration::from_secs(600)));
        assert!(!throttle.try_begin("vault-a", start + Duration::from_secs(601)));
    }
}
