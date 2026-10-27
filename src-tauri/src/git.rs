//! Thin wrapper around the system `git` binary.
//!
//! Every operation in this app shells out to the user's own git. Nothing here
//! reimplements git behaviour or touches `.git` directly, so anything this app
//! does is immediately visible to `git status` in a terminal.

use serde::Serialize;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

static GIT_BIN: OnceLock<String> = OnceLock::new();

/// Locate the user's git.
///
/// A GUI launched from Finder inherits a bare `PATH` (`/usr/bin:/bin:...`), so
/// asking the login shell is the only way to end up on the same binary the
/// user's terminal uses (e.g. Homebrew git rather than Apple git).
pub fn git_bin() -> &'static str {
    GIT_BIN
        .get_or_init(|| {
            if let Ok(p) = std::env::var("STAGE_GIT_PATH")
                && !p.is_empty()
                && Path::new(&p).exists()
            {
                return p;
            }
            if let Ok(shell) = std::env::var("SHELL")
                && let Ok(out) = Command::new(&shell)
                    .args(["-l", "-c", "command -v git"])
                    .output()
            {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if out.status.success() && !p.is_empty() && Path::new(&p).exists() {
                    return p;
                }
            }
            for c in [
                "/opt/homebrew/bin/git",
                "/usr/local/bin/git",
                "/usr/bin/git",
            ] {
                if Path::new(c).exists() {
                    return c.to_string();
                }
            }
            "git".to_string()
        })
        .as_str()
}

fn base(root: &str) -> Command {
    let mut c = Command::new(git_bin());
    c.current_dir(root)
        // quotePath=false keeps non-ASCII paths readable instead of \xxx escaped
        .args(["-c", "core.quotePath=false", "-c", "color.ui=false"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("LC_ALL", "C.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}

pub struct Out {
    pub code: i32,
    pub out: Vec<u8>,
    pub err: String,
}

impl Out {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.out).into_owned()
    }
    fn fail(&self, what: &str) -> String {
        if self.err.is_empty() {
            format!("git {what} exited with code {}", self.code)
        } else {
            self.err.clone()
        }
    }
}

pub fn run(root: &str, args: &[&str]) -> Result<Out, String> {
    let o = base(root)
        .args(args)
        .output()
        .map_err(|e| format!("could not run {}: {e}", git_bin()))?;
    Ok(Out {
        code: o.status.code().unwrap_or(-1),
        out: o.stdout,
        err: String::from_utf8_lossy(&o.stderr).trim().to_string(),
    })
}

pub fn run_ok(root: &str, args: &[&str]) -> Result<String, String> {
    let o = run(root, args)?;
    if o.code != 0 {
        return Err(o.fail(&args.join(" ")));
    }
    Ok(o.text())
}

pub fn run_stdin(root: &str, args: &[&str], input: &str) -> Result<Out, String> {
    let mut child = base(root)
        .args(args)
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", git_bin()))?;
    child
        .stdin
        .as_mut()
        .expect("stdin piped")
        .write_all(input.as_bytes())
        .map_err(|e| format!("could not write patch to git: {e}"))?;
    let o = child
        .wait_with_output()
        .map_err(|e| format!("git did not finish: {e}"))?;
    Ok(Out {
        code: o.status.code().unwrap_or(-1),
        out: o.stdout,
        err: String::from_utf8_lossy(&o.stderr).trim().to_string(),
    })
}

// ---------------------------------------------------------------- repository

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
    pub name: String,
}

pub fn discover(path: &str) -> Result<RepoInfo, String> {
    let mut p = PathBuf::from(path);
    if p.is_file() {
        p.pop();
    }
    if !p.is_dir() {
        return Err(format!("{} is not a folder", p.display()));
    }
    let dir = p.to_string_lossy().into_owned();
    let o = run(&dir, &["rev-parse", "--show-toplevel"])?;
    if o.code != 0 {
        return Err(format!("{} is not inside a git repository", p.display()));
    }
    let root = o.text().trim().to_string();
    let name = Path::new(&root)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.clone());
    Ok(RepoInfo { root, name })
}

// -------------------------------------------------------------------- status

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub orig_path: Option<String>,
    /// Index-side status letter from porcelain v2 (`.` means unchanged).
    pub index_status: String,
    /// Worktree-side status letter from porcelain v2.
    pub work_status: String,
    pub untracked: bool,
    pub unmerged: bool,
    /// "none" | "partial" | "all" — drives the tri-state checkbox.
    pub staged_state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub detached: bool,
    pub files: Vec<FileEntry>,
}

fn staged_state(index: char, work: char) -> &'static str {
    match (index != '.', work != '.') {
        (true, true) => "partial",
        (true, false) => "all",
        _ => "none",
    }
}

pub fn status(root: &str) -> Result<Status, String> {
    let o = run(
        root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    if o.code != 0 {
        return Err(o.fail("status"));
    }

    // -z output is a flat sequence of NUL-terminated fields. Most records are
    // one field, but rename records (`2 `) are followed by a second field
    // holding the original path, so this has to be consumed sequentially.
    let parts: Vec<String> = o
        .out
        .split(|b| *b == 0)
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();

    let mut st = Status {
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        detached: false,
        files: Vec::new(),
    };

    let mut i = 0usize;
    while i < parts.len() {
        let rec = parts[i].clone();
        i += 1;
        if rec.is_empty() {
            continue;
        }

        if let Some(h) = rec.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.head ") {
                if v == "(detached)" {
                    st.detached = true;
                } else {
                    st.branch = Some(v.to_string());
                }
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                st.upstream = Some(v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                for tok in v.split_whitespace() {
                    if let Some(n) = tok.strip_prefix('+') {
                        st.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = tok.strip_prefix('-') {
                        st.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }

        match rec.as_bytes()[0] {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            b'1' => {
                let t: Vec<&str> = rec.splitn(9, ' ').collect();
                if t.len() < 9 {
                    continue;
                }
                let xy: Vec<char> = t[1].chars().collect();
                let (x, y) = (xy[0], xy[1]);
                st.files.push(FileEntry {
                    path: t[8].to_string(),
                    orig_path: None,
                    index_status: x.to_string(),
                    work_status: y.to_string(),
                    untracked: false,
                    unmerged: false,
                    staged_state: staged_state(x, y).to_string(),
                });
            }
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
            b'2' => {
                let t: Vec<&str> = rec.splitn(10, ' ').collect();
                if t.len() < 10 {
                    continue;
                }
                let orig = parts.get(i).cloned();
                i += 1;
                let xy: Vec<char> = t[1].chars().collect();
                let (x, y) = (xy[0], xy[1]);
                st.files.push(FileEntry {
                    path: t[9].to_string(),
                    orig_path: orig,
                    index_status: x.to_string(),
                    work_status: y.to_string(),
                    untracked: false,
                    unmerged: false,
                    staged_state: staged_state(x, y).to_string(),
                });
            }
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            b'u' => {
                let t: Vec<&str> = rec.splitn(11, ' ').collect();
                if t.len() < 11 {
                    continue;
                }
                st.files.push(FileEntry {
                    path: t[10].to_string(),
                    orig_path: None,
                    index_status: "U".into(),
                    work_status: "U".into(),
                    untracked: false,
                    unmerged: true,
                    staged_state: "none".into(),
                });
            }
            // ? <path>
            b'?' => {
                st.files.push(FileEntry {
                    path: rec[2..].to_string(),
                    orig_path: None,
                    index_status: ".".into(),
                    work_status: "?".into(),
                    untracked: true,
                    unmerged: false,
                    staged_state: "none".into(),
                });
            }
            _ => {}
        }
    }

    st.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(st)
}

// ---------------------------------------------------------------------- diff

/// Context large enough that git emits the whole file in one hunk. Full
/// context is what makes the three-way alignment possible, and it also makes
/// every generated patch a single hunk starting at line 1.
const FULL_CONTEXT: &str = "-U1000000";

/// `git diff --cached` for one file: HEAD → index.
pub fn diff_head_to_index(root: &str, path: &str) -> Result<String, String> {
    let o = run(
        root,
        &[
            "diff",
            "--cached",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            FULL_CONTEXT,
            "--",
            path,
        ],
    )?;
    if o.code != 0 {
        return Err(o.fail("diff --cached"));
    }
    Ok(o.text())
}

/// `git diff` for one file: index → worktree.
pub fn diff_index_to_worktree(root: &str, path: &str) -> Result<String, String> {
    let o = run(
        root,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            FULL_CONTEXT,
            "--",
            path,
        ],
    )?;
    if o.code != 0 {
        return Err(o.fail("diff"));
    }
    Ok(o.text())
}

/// Untracked files have no blob to diff against, so their contents are shown
/// as an all-additions patch. Display only — they stage as a whole.
pub fn diff_untracked(root: &str, path: &str) -> Result<String, String> {
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let o = run(
        root,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-index",
            FULL_CONTEXT,
            "--",
            null,
            path,
        ],
    )?;
    // --no-index exits 1 when the files differ, which is the normal case.
    if o.code > 1 {
        return Err(o.fail("diff --no-index"));
    }
    Ok(o.text())
}

// ------------------------------------------------------------ whole-file ops

pub fn has_head(root: &str) -> bool {
    run(root, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|o| o.code == 0)
        .unwrap_or(false)
}

pub fn stage_file(root: &str, path: &str) -> Result<(), String> {
    run_ok(root, &["add", "--", path]).map(|_| ())
}

pub fn unstage_file(root: &str, path: &str, orig_path: Option<&str>) -> Result<(), String> {
    if has_head(root) {
        let mut args = vec!["restore", "--staged", "--", path];
        if let Some(op) = orig_path {
            args.push(op);
        }
        run_ok(root, &args).map(|_| ())
    } else {
        // No commits yet: there is nothing to restore from, so drop the entry.
        run_ok(root, &["rm", "--cached", "--force", "--", path]).map(|_| ())
    }
}

pub fn stage_all(root: &str) -> Result<(), String> {
    run_ok(root, &["add", "--all"]).map(|_| ())
}

pub fn unstage_all(root: &str) -> Result<(), String> {
    if has_head(root) {
        run_ok(root, &["reset", "--quiet", "HEAD", "--"]).map(|_| ())
    } else {
        run_ok(root, &["rm", "--cached", "-r", "--force", "--quiet", "."]).map(|_| ())
    }
}

// -------------------------------------------------------------------- commit

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub subject: String,
    pub relative: String,
}

pub fn last_commit(root: &str) -> Result<Option<CommitInfo>, String> {
    if !has_head(root) {
        return Ok(None);
    }
    let out = run_ok(
        root,
        &["log", "-1", "--no-color", "--format=%h%x00%s%x00%cr"],
    )?;
    let t: Vec<&str> = out.trim_end().split('\0').collect();
    if t.len() < 3 {
        return Ok(None);
    }
    Ok(Some(CommitInfo {
        hash: t[0].to_string(),
        subject: t[1].to_string(),
        relative: t[2].to_string(),
    }))
}

pub fn commit(root: &str, summary: &str, description: &str) -> Result<String, String> {
    let summary = summary.trim();
    if summary.is_empty() {
        return Err("A summary is required.".into());
    }
    let mut args = vec!["commit", "-m", summary];
    let desc = description.trim();
    if !desc.is_empty() {
        args.push("-m");
        args.push(desc);
    }
    let o = run(root, &args)?;
    if o.code != 0 {
        let msg = if o.err.is_empty() { o.text() } else { o.err };
        return Err(msg.trim().to_string());
    }
    Ok(o.text().trim().to_string())
}
