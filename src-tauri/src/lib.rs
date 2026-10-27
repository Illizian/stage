mod git;
mod unified;

use serde::Serialize;
use std::collections::HashSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDiff {
    path: String,
    binary: bool,
    truncated: bool,
    /// Whether individual lines can be picked. False for untracked files,
    /// binaries, and renames — those are whole-file only.
    selectable: bool,
    /// Why `selectable` is false, shown as a hint in the diff pane.
    reason: Option<String>,
    rows: Vec<unified::Row>,
    /// Guards against acting on a stale view if the file or index changed
    /// between rendering the diff and clicking a line.
    hash: String,
}

/// Diffs above this many rows are cut off. Folded rows are not rendered until
/// expanded, so this is about payload size rather than DOM size.
const MAX_ROWS: usize = 20_000;

#[tauri::command]
fn open_repo(path: String) -> Result<git::RepoInfo, String> {
    git::discover(&path)
}

#[tauri::command]
fn repo_status(root: String) -> Result<git::Status, String> {
    git::status(&root)
}

/// The whole-file cases, rendered read-only with an explanation.
fn whole_file_only(path: &str, rows: Vec<unified::Row>, hash: String, reason: &str) -> FileDiff {
    FileDiff {
        path: path.to_string(),
        binary: false,
        truncated: false,
        selectable: false,
        reason: Some(reason.to_string()),
        rows,
        hash,
    }
}

#[tauri::command]
fn file_diff(
    root: String,
    path: String,
    orig_path: Option<String>,
    untracked: bool,
) -> Result<FileDiff, String> {
    if untracked {
        let raw = git::diff_untracked(&root, &path)?;
        let align = unified::parse_align(&raw);
        let hash = unified::hash(&raw, "");
        if align.binary {
            return Ok(whole_file_only(&path, Vec::new(), hash, "Binary file."));
        }
        // Everything in an untracked file is an unstaged addition.
        let empty = unified::Align {
            lines: Vec::new(),
            binary: false,
        };
        let rows = unified::merge(&unified::context_only_from_index(&empty, false), &align)
            .unwrap_or_default();
        return Ok(whole_file_only(
            &path,
            rows,
            hash,
            "New file \u{2014} git has nothing to diff against yet, so it stages as a whole.",
        ));
    }

    let a_raw = git::diff_head_to_index(&root, &path)?;
    let b_raw = git::diff_index_to_worktree(&root, &path)?;
    let hash = unified::hash(&a_raw, &b_raw);

    let mut a = unified::parse_align(&a_raw);
    let mut b = unified::parse_align(&b_raw);

    if a.binary || b.binary {
        return Ok(whole_file_only(&path, Vec::new(), hash, "Binary file."));
    }

    // When one side is identical, git prints nothing; fill it in from the
    // other alignment's index side so the merge has both halves.
    if a_raw.is_empty() {
        a = unified::context_only_from_index(&b, true);
    }
    if b_raw.is_empty() {
        b = unified::context_only_from_index(&a, false);
    }

    let mut rows = match unified::merge(&a, &b) {
        Ok(r) => r,
        Err(e) => return Ok(whole_file_only(&path, Vec::new(), hash, &e)),
    };

    let truncated = rows.len() > MAX_ROWS;
    if truncated {
        rows.truncate(MAX_ROWS);
    }

    let (selectable, reason) = if orig_path.is_some() {
        (
            false,
            Some("Renamed file \u{2014} stage or unstage it as a whole.".to_string()),
        )
    } else if truncated {
        (
            false,
            Some(format!("Diff is over {MAX_ROWS} lines and was cut off.")),
        )
    } else {
        (true, None)
    };

    Ok(FileDiff {
        path,
        binary: false,
        truncated,
        selectable,
        reason,
        rows,
        hash,
    })
}

#[tauri::command]
fn stage_file(root: String, path: String) -> Result<(), String> {
    git::stage_file(&root, &path)
}

#[tauri::command]
fn unstage_file(root: String, path: String, orig_path: Option<String>) -> Result<(), String> {
    git::unstage_file(&root, &path, orig_path.as_deref())
}

#[tauri::command]
fn stage_all(root: String) -> Result<(), String> {
    git::stage_all(&root)
}

#[tauri::command]
fn unstage_all(root: String) -> Result<(), String> {
    git::unstage_all(&root)
}

/// Stage or unstage the given lines.
///
/// `positions` are `Row::pos` values, which index into alignment B when
/// staging and alignment A when unstaging — the caller sends only rows that
/// are not already in the requested state, so one call is one direction.
#[tauri::command]
fn set_lines_staged(
    root: String,
    path: String,
    positions: Vec<usize>,
    staged: bool,
    hash: String,
) -> Result<(), String> {
    let a_raw = git::diff_head_to_index(&root, &path)?;
    let b_raw = git::diff_index_to_worktree(&root, &path)?;
    if unified::hash(&a_raw, &b_raw) != hash {
        return Err(
            "This file changed on disk. The view has been refreshed \u{2014} try again.".into(),
        );
    }

    let a = unified::parse_align(&a_raw);
    let b = unified::parse_align(&b_raw);
    if a.binary || b.binary {
        return Err("Binary files can only be staged whole.".into());
    }

    // Staging reads from index → worktree; unstaging reverses HEAD → index.
    let align = if staged { &b } else { &a };
    let selected: HashSet<usize> = positions.into_iter().collect();
    let patch = unified::build_patch(align, &selected, !staged, &path)
        .ok_or_else(|| "No lines were selected.".to_string())?;

    let mut args = vec!["apply", "--cached", "--recount", "--whitespace=nowarn"];
    if !staged {
        args.push("--reverse");
    }
    args.push("-");

    let out = git::run_stdin(&root, &args, &patch)?;
    if out.code != 0 {
        eprintln!("--- patch that failed to apply ---\n{patch}---");
        let msg = if out.err.is_empty() {
            format!("git apply exited with code {}", out.code)
        } else {
            out.err
        };
        return Err(msg);
    }
    Ok(())
}

#[tauri::command]
fn commit(root: String, summary: String, description: String) -> Result<String, String> {
    git::commit(&root, &summary, &description)
}

#[tauri::command]
fn last_commit(root: String) -> Result<Option<git::CommitInfo>, String> {
    git::last_commit(&root)
}

/// A repository named on the command line (`Stage /path/to/repo`) or via
/// `STAGE_OPEN`, so the app can be wired to a shell alias.
#[tauri::command]
fn initial_repo() -> Option<String> {
    if let Ok(p) = std::env::var("STAGE_OPEN")
        && !p.is_empty()
    {
        return Some(p);
    }
    std::env::args()
        .nth(1)
        .filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir())
}

/// Shown in the about/footer so it is obvious which git is actually in use.
#[tauri::command]
fn git_info() -> Result<String, String> {
    let version = git::run_ok(".", &["--version"])?;
    Ok(format!("{} ({})", version.trim(), git::git_bin()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            repo_status,
            file_diff,
            stage_file,
            unstage_file,
            stage_all,
            unstage_all,
            set_lines_staged,
            commit,
            last_commit,
            git_info,
            initial_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Helpers shared by the end-to-end test modules below.
#[cfg(test)]
mod e2e_support {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    pub fn sh(root: &str, args: &[&str]) -> String {
        let o = Command::new(git::git_bin())
            .current_dir(root)
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            o.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    /// A fresh repo with `f.txt` committed as `original`.
    pub fn repo(original: &str) -> String {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let mut dir: PathBuf = std::env::temp_dir();
        dir.push(format!("stage-test-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let root = dir.to_string_lossy().into_owned();

        sh(&root, &["init", "--quiet", "--initial-branch=main"]);
        sh(&root, &["config", "user.email", "test@example.com"]);
        sh(&root, &["config", "user.name", "Test"]);
        fs::write(dir.join("f.txt"), original).expect("write");
        sh(&root, &["add", "f.txt"]);
        sh(&root, &["commit", "--quiet", "-m", "initial"]);
        root
    }

    pub fn write(root: &str, contents: &str) {
        fs::write(PathBuf::from(root).join("f.txt"), contents).expect("write");
    }

    /// Contents of f.txt as it currently stands *in the index*.
    pub fn index_contents(root: &str) -> String {
        sh(root, &["show", ":f.txt"])
    }

    pub fn porcelain(root: &str) -> String {
        sh(root, &["status", "--porcelain"]).trim_end().to_string()
    }

    pub fn diff_of(root: &str) -> FileDiff {
        file_diff(root.to_string(), "f.txt".into(), None, false).expect("diff")
    }

    /// Changed rows as (kind, text, staged) — the view the user sees.
    pub fn changed(d: &FileDiff) -> Vec<(&'static str, String, bool)> {
        d.rows
            .iter()
            .filter(|r| r.kind != "context")
            .map(|r| (r.kind, r.text.clone(), r.staged))
            .collect()
    }

    /// `pos` handles for the changed rows whose text matches, used to toggle
    /// them the way a click would.
    pub fn handles(d: &FileDiff, texts: &[&str], staged: bool) -> Vec<usize> {
        d.rows
            .iter()
            .filter(|r| r.kind != "context" && r.staged == staged)
            .filter(|r| texts.contains(&r.text.as_str()))
            .map(|r| r.pos)
            .collect()
    }
}

/// End-to-end tests against real throwaway repositories.
///
/// `unified`'s own tests cover the alignment logic in isolation; these prove
/// the user's actual `git` accepts the generated patches and that the index
/// afterwards is what `git status` reports on the command line.
#[cfg(test)]
mod e2e {
    use super::e2e_support::*;
    use super::*;

    const BEFORE: &str = "one\ntwo\nthree\nfour\nfive\n";
    const AFTER: &str = "one\nTWO\ntwo-and-a-half\nthree\nfour\nfive\n";

    #[test]
    fn unstaged_changes_show_as_unchecked() {
        let root = repo(BEFORE);
        write(&root, AFTER);
        assert_eq!(
            changed(&diff_of(&root)),
            vec![
                ("del", "two".into(), false),
                ("add", "TWO".into(), false),
                ("add", "two-and-a-half".into(), false),
            ]
        );
    }

    #[test]
    fn staging_one_line_leaves_the_others_unchecked() {
        let root = repo(BEFORE);
        write(&root, AFTER);

        let d = diff_of(&root);
        let h = handles(&d, &["TWO"], false);
        assert_eq!(h.len(), 1);
        set_lines_staged(root.clone(), "f.txt".into(), h, true, d.hash).expect("stage");

        // Real git now reports the file as both staged and unstaged.
        assert_eq!(porcelain(&root), "MM f.txt");
        assert_eq!(index_contents(&root), "one\ntwo\nTWO\nthree\nfour\nfive\n");

        // And crucially the line is still *visible*, now with a tick, rather
        // than vanishing from the view.
        assert_eq!(
            changed(&diff_of(&root)),
            vec![
                ("del", "two".into(), false),
                ("add", "TWO".into(), true),
                ("add", "two-and-a-half".into(), false),
            ]
        );
    }

    #[test]
    fn unchecking_a_staged_line_puts_it_back() {
        let root = repo(BEFORE);
        write(&root, AFTER);
        sh(&root, &["add", "f.txt"]);

        let d = diff_of(&root);
        assert!(changed(&d).iter().all(|(_, _, staged)| *staged));

        let h = handles(&d, &["two-and-a-half"], true);
        assert_eq!(h.len(), 1);
        set_lines_staged(root.clone(), "f.txt".into(), h, false, d.hash).expect("unstage");

        assert_eq!(porcelain(&root), "MM f.txt");
        assert_eq!(index_contents(&root), "one\nTWO\nthree\nfour\nfive\n");
        assert_eq!(
            changed(&diff_of(&root)),
            vec![
                ("del", "two".into(), true),
                ("add", "TWO".into(), true),
                ("add", "two-and-a-half".into(), false),
            ]
        );
    }

    #[test]
    fn staging_a_deletion_only() {
        let root = repo(BEFORE);
        write(&root, AFTER);

        let d = diff_of(&root);
        let h = handles(&d, &["two"], false);
        set_lines_staged(root.clone(), "f.txt".into(), h, true, d.hash).expect("stage");

        assert_eq!(index_contents(&root), "one\nthree\nfour\nfive\n");
        assert_eq!(
            changed(&diff_of(&root)),
            vec![
                ("del", "two".into(), true),
                ("add", "TWO".into(), false),
                ("add", "two-and-a-half".into(), false),
            ]
        );
    }

    #[test]
    fn staging_across_two_separate_regions() {
        let before: String = (1..=20).map(|i| format!("l{i}\n")).collect();
        let after: String = (1..=20)
            .map(|i| match i {
                5 => "L5\n".to_string(),
                15 => "L15\n".to_string(),
                _ => format!("l{i}\n"),
            })
            .collect();

        let root = repo(&before);
        write(&root, &after);

        let d = diff_of(&root);
        let h = handles(&d, &["L5", "L15"], false);
        assert_eq!(h.len(), 2);
        set_lines_staged(root.clone(), "f.txt".into(), h, true, d.hash).expect("stage");

        let expected: String = (1..=20)
            .map(|i| match i {
                5 => "l5\nL5\n".to_string(),
                15 => "l15\nL15\n".to_string(),
                _ => format!("l{i}\n"),
            })
            .collect();
        assert_eq!(index_contents(&root), expected);
        assert_eq!(porcelain(&root), "MM f.txt");
    }

    #[test]
    fn toggling_the_same_line_back_and_forth_is_a_round_trip() {
        let root = repo(BEFORE);
        write(&root, AFTER);
        let clean = index_contents(&root);

        for _ in 0..3 {
            let d = diff_of(&root);
            let h = handles(&d, &["TWO"], false);
            set_lines_staged(root.clone(), "f.txt".into(), h, true, d.hash).expect("stage");

            let d = diff_of(&root);
            let h = handles(&d, &["TWO"], true);
            set_lines_staged(root.clone(), "f.txt".into(), h, false, d.hash).expect("unstage");
        }

        assert_eq!(index_contents(&root), clean);
        assert_eq!(porcelain(&root), " M f.txt");
    }

    #[test]
    fn rows_are_folded_away_far_from_changes() {
        let before: String = (1..=40).map(|i| format!("l{i}\n")).collect();
        let after = before.replace("l20\n", "L20\n");
        let root = repo(&before);
        write(&root, &after);

        let d = diff_of(&root);
        assert_eq!(d.rows.len(), 41, "every line of the file is present");
        let visible = d.rows.iter().filter(|r| r.visible).count();
        assert_eq!(visible, 8, "the change plus three lines either side");
        assert!(d.rows.iter().any(|r| !r.visible && r.gap > 0));
    }

    #[test]
    fn stale_view_is_rejected_rather_than_misapplied() {
        let root = repo(BEFORE);
        write(&root, AFTER);
        let d = diff_of(&root);
        let h = handles(&d, &["TWO"], false);

        write(&root, "completely\ndifferent\n");

        let err = set_lines_staged(root.clone(), "f.txt".into(), h, true, d.hash)
            .expect_err("must refuse a stale selection");
        assert!(err.contains("changed on disk"), "{err}");
        assert_eq!(porcelain(&root), " M f.txt");
    }

    #[test]
    fn a_fully_staged_file_shows_every_line_checked() {
        let root = repo(BEFORE);
        write(&root, AFTER);
        sh(&root, &["add", "f.txt"]);
        assert_eq!(porcelain(&root), "M  f.txt");

        let d = diff_of(&root);
        assert!(!changed(&d).is_empty());
        assert!(changed(&d).iter().all(|(_, _, staged)| *staged));
    }

    #[test]
    fn a_file_added_to_the_index_shows_every_line_staged() {
        let root = repo("base\n");
        std::fs::write(std::path::PathBuf::from(&root).join("n.txt"), "x\ny\nz\n").expect("write");
        sh(&root, &["add", "n.txt"]);
        assert_eq!(porcelain(&root), "A  n.txt");

        // HEAD has no blob at all, so this exercises the empty-A side.
        let d = file_diff(root.clone(), "n.txt".into(), None, false).expect("diff");
        let rows: Vec<_> = d
            .rows
            .iter()
            .filter(|r| r.kind != "context")
            .map(|r| (r.kind, r.text.clone(), r.staged))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("add", "x".into(), true),
                ("add", "y".into(), true),
                ("add", "z".into(), true),
            ]
        );

        // Taking one line back out leaves the file added but partly staged.
        let pos = d
            .rows
            .iter()
            .find(|r| r.text == "y")
            .map(|r| r.pos)
            .expect("row");
        set_lines_staged(root.clone(), "n.txt".into(), vec![pos], false, d.hash).expect("unstage");
        assert_eq!(sh(&root, &["show", ":n.txt"]), "x\nz\n");
        assert_eq!(porcelain(&root), "AM n.txt");
    }

    #[test]
    fn a_deleted_file_can_have_part_of_its_removal_staged() {
        let root = repo("a\nb\nc\n");
        std::fs::remove_file(std::path::PathBuf::from(&root).join("f.txt")).expect("rm");
        assert_eq!(porcelain(&root), " D f.txt");

        let d = diff_of(&root);
        assert_eq!(
            changed(&d),
            vec![
                ("del", "a".into(), false),
                ("del", "b".into(), false),
                ("del", "c".into(), false),
            ]
        );

        let h = handles(&d, &["b"], false);
        set_lines_staged(root.clone(), "f.txt".into(), h, true, d.hash).expect("stage");
        assert_eq!(index_contents(&root), "a\nc\n");
        assert_eq!(porcelain(&root), "MD f.txt");
    }

    #[test]
    fn status_reports_staged_state_per_file() {
        let root = repo(BEFORE);
        write(&root, AFTER);
        std::fs::write(std::path::PathBuf::from(&root).join("new.txt"), "hi\n").expect("write");

        let s = git::status(&root).expect("status");
        assert_eq!(s.branch.as_deref(), Some("main"));
        let f = s.files.iter().find(|f| f.path == "f.txt").expect("f.txt");
        assert_eq!(f.staged_state, "none");
        assert!(s.files.iter().any(|f| f.path == "new.txt" && f.untracked));

        sh(&root, &["add", "f.txt"]);
        write(&root, "one\nTWO\nchanged again\n");
        let s = git::status(&root).expect("status");
        let f = s.files.iter().find(|f| f.path == "f.txt").expect("f.txt");
        assert_eq!(f.staged_state, "partial");
    }

    #[test]
    fn commit_uses_the_real_git_and_clears_the_index() {
        let root = repo(BEFORE);
        write(&root, AFTER);
        sh(&root, &["add", "f.txt"]);

        commit(root.clone(), "a summary".into(), "a body".into()).expect("commit");
        assert_eq!(porcelain(&root), "");

        let msg = sh(&root, &["log", "-1", "--format=%B"]);
        assert!(msg.contains("a summary"), "{msg}");
        assert!(msg.contains("a body"), "{msg}");
        assert_eq!(
            last_commit(root.clone())
                .expect("last")
                .expect("some")
                .subject,
            "a summary"
        );
    }
}

/// Dumps real backend output for the repo in `STAGE_OPEN` to `STAGE_FIXTURE`.
/// Used to render the real UI outside the app shell while developing styles.
/// Run with: `cargo test -- --ignored dump_ui_fixture`
#[cfg(test)]
#[test]
#[ignore]
fn dump_ui_fixture() {
    let root = std::env::var("STAGE_OPEN").expect("STAGE_OPEN");
    let out = std::env::var("STAGE_FIXTURE").expect("STAGE_FIXTURE");

    let status = git::status(&root).expect("status");
    let mut diffs = serde_json::Map::new();
    for f in &status.files {
        if let Ok(d) = file_diff(
            root.clone(),
            f.path.clone(),
            f.orig_path.clone(),
            f.untracked,
        ) {
            diffs.insert(f.path.clone(), serde_json::to_value(&d).expect("json"));
        }
    }

    let doc = serde_json::json!({
        "root": root,
        "name": std::path::Path::new(&root).file_name().unwrap().to_string_lossy(),
        "status": status,
        "lastCommit": last_commit(root.clone()).expect("last"),
        "diffs": diffs,
    });
    std::fs::write(&out, serde_json::to_string_pretty(&doc).expect("json")).expect("write");
    eprintln!("wrote {out}");
}

/// Stages a single line of `STAGE_FILE` in the repo at `STAGE_OPEN`, through
/// the same command the UI calls. Used to set up a realistic mixed state.
/// Run with: `cargo test -- --ignored stage_one_line`
#[cfg(test)]
#[test]
#[ignore]
fn stage_one_line() {
    let root = std::env::var("STAGE_OPEN").expect("STAGE_OPEN");
    let path = std::env::var("STAGE_FILE").expect("STAGE_FILE");

    let d = file_diff(root.clone(), path.clone(), None, false).expect("diff");
    let pos = d
        .rows
        .iter()
        .find(|r| r.selectable && !r.staged)
        .map(|r| r.pos)
        .expect("an unstaged change");
    set_lines_staged(root, path, vec![pos], true, d.hash).expect("stage");
}
