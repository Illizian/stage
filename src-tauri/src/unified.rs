//! One diff view whose checkmarks are the real index.
//!
//! The pane shows HEAD → worktree, and every changed line carries a checkbox
//! saying whether that change is currently staged. Git will not report that
//! directly, so it is derived from the two diffs git *will* give us, both taken
//! at full context so they describe every line:
//!
//! ```text
//!   A = git diff --cached   HEAD  → index
//!   B = git diff            index → worktree
//! ```
//!
//! Both are alignments sharing the same middle, so walking them together keyed
//! on index line numbers yields a three-way alignment of (HEAD, index,
//! worktree). From that, each line's presence in the three sides says both what
//! it is and whether it is staged:
//!
//! ```text
//!   HEAD  index  worktree
//!    yes   yes    yes      context
//!    no    yes    yes      addition, staged      (checked)
//!    no    no     yes      addition, unstaged    (unchecked)
//!    yes   no     no       deletion, staged      (checked)
//!    yes   yes    no       deletion, unstaged    (unchecked)
//! ```
//!
//! Toggling a line is then a patch built from whichever alignment holds it —
//! B to stage, A to unstage — and because both are full-context, each patch is
//! a single hunk starting at line 1 with no offset arithmetic at all.

use serde::Serialize;
use std::collections::HashSet;
use std::hash::{DefaultHasher, Hash, Hasher};

/// Context lines kept around each change before the rest is folded away.
const CONTEXT: usize = 3;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Op {
    /// Present on both sides of this diff.
    Ctx,
    /// Present on the left side only.
    Del,
    /// Present on the right side only.
    Add,
}

#[derive(Clone)]
pub struct AlignLine {
    pub op: Op,
    pub text: String,
    /// This line was followed by "\ No newline at end of file".
    pub nonl: bool,
}

pub struct Align {
    pub lines: Vec<AlignLine>,
    pub binary: bool,
}

impl Align {
    /// Lines present on the left side (HEAD for A, index for B).
    pub fn left_len(&self) -> usize {
        self.lines
            .iter()
            .filter(|l| matches!(l.op, Op::Ctx | Op::Del))
            .count()
    }

    /// Lines present on the right side (index for A, worktree for B).
    pub fn right_len(&self) -> usize {
        self.lines
            .iter()
            .filter(|l| matches!(l.op, Op::Ctx | Op::Add))
            .count()
    }

    /// An alignment of a file with itself: every line unchanged.
    fn all_context(texts: Vec<(String, bool)>) -> Align {
        Align {
            lines: texts
                .into_iter()
                .map(|(text, nonl)| AlignLine {
                    op: Op::Ctx,
                    text,
                    nonl,
                })
                .collect(),
            binary: false,
        }
    }
}

/// Parse a full-context unified diff into a flat alignment.
pub fn parse_align(text: &str) -> Align {
    let mut lines: Vec<AlignLine> = Vec::new();
    let mut binary = false;
    let mut in_hunk = false;

    let text = text.strip_suffix('\n').unwrap_or(text);
    for line in text.split('\n') {
        if line.starts_with("@@ ") {
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            // The `--- a/x` / `+++ b/x` header lines also start with -/+, so
            // nothing is collected until the first hunk marker is seen.
            if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                binary = true;
            }
            continue;
        }

        let push = |lines: &mut Vec<AlignLine>, op: Op, text: &str| {
            lines.push(AlignLine {
                op,
                text: text.to_string(),
                nonl: false,
            })
        };

        match line.as_bytes().first() {
            Some(b' ') => push(&mut lines, Op::Ctx, &line[1..]),
            Some(b'-') => push(&mut lines, Op::Del, &line[1..]),
            Some(b'+') => push(&mut lines, Op::Add, &line[1..]),
            Some(b'\\') => {
                if let Some(l) = lines.last_mut() {
                    l.nonl = true;
                }
            }
            None => push(&mut lines, Op::Ctx, ""),
            // A following `diff --git` header ends this file's hunks.
            _ => in_hunk = false,
        }
    }

    Align { lines, binary }
}

// ----------------------------------------------------------------- merging

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub idx: usize,
    /// "context" | "add" | "del"
    pub kind: &'static str,
    pub text: String,
    /// Line number in HEAD.
    pub old_line: Option<i64>,
    /// Line number in the worktree.
    pub new_line: Option<i64>,
    /// Whether this change is currently in the index.
    pub staged: bool,
    pub selectable: bool,
    /// Position in alignment A when staged, or B when unstaged — the handle
    /// used to build the patch that toggles this line.
    pub pos: usize,
    /// Contiguous run of changed lines this row belongs to, for hunk toggling.
    pub group: usize,
    /// False for unchanged lines far from any change; the UI folds these away.
    pub visible: bool,
    /// Identifies the folded run, so the UI can expand one gap at a time.
    pub gap: usize,
    pub nonl: bool,
}

/// Build the unified view from the two alignments.
pub fn merge(a: &Align, b: &Align) -> Result<Vec<Row>, String> {
    // Both alignments describe the same index blob, so they must agree on how
    // many lines it has. If they do not, something changed underneath us.
    if a.right_len() != b.left_len() {
        return Err(format!(
            "the index changed while reading it ({} vs {} lines)",
            a.right_len(),
            b.left_len()
        ));
    }
    let n = a.right_len();

    // Walk A (HEAD → index), recording for each index line where it came from,
    // plus the HEAD-only lines that fall before it.
    let mut i_to_h: Vec<Option<i64>> = vec![None; n + 1];
    let mut a_pos_of_i: Vec<usize> = vec![0; n + 1];
    let mut a_nonl_of_i: Vec<bool> = vec![false; n + 1];
    let mut head_only: Vec<Vec<(usize, i64, String, bool)>> = vec![Vec::new(); n + 1];
    {
        let mut i = 0usize;
        let mut h = 1i64;
        for (pos, l) in a.lines.iter().enumerate() {
            match l.op {
                Op::Ctx => {
                    i += 1;
                    i_to_h[i] = Some(h);
                    a_pos_of_i[i] = pos;
                    a_nonl_of_i[i] = l.nonl;
                    h += 1;
                }
                Op::Add => {
                    i += 1;
                    i_to_h[i] = None;
                    a_pos_of_i[i] = pos;
                    a_nonl_of_i[i] = l.nonl;
                }
                Op::Del => {
                    head_only[i].push((pos, h, l.text.clone(), l.nonl));
                    h += 1;
                }
            }
        }
    }

    // Walk B (index → worktree) the same way.
    let mut i_to_w: Vec<Option<i64>> = vec![None; n + 1];
    let mut b_pos_of_i: Vec<usize> = vec![0; n + 1];
    let mut work_only: Vec<Vec<(usize, i64, String, bool)>> = vec![Vec::new(); n + 1];
    let mut text_of_i: Vec<String> = vec![String::new(); n + 1];
    {
        let mut i = 0usize;
        let mut w = 1i64;
        for (pos, l) in b.lines.iter().enumerate() {
            match l.op {
                Op::Ctx => {
                    i += 1;
                    i_to_w[i] = Some(w);
                    b_pos_of_i[i] = pos;
                    text_of_i[i] = l.text.clone();
                    w += 1;
                }
                Op::Del => {
                    i += 1;
                    i_to_w[i] = None;
                    b_pos_of_i[i] = pos;
                    text_of_i[i] = l.text.clone();
                }
                Op::Add => {
                    work_only[i].push((pos, w, l.text.clone(), l.nonl));
                    w += 1;
                }
            }
        }
    }

    let mut rows: Vec<Row> = Vec::new();
    let mut push = |kind, text: String, old, new, staged, selectable, pos, nonl| {
        rows.push(Row {
            idx: 0,
            kind,
            text,
            old_line: old,
            new_line: new,
            staged,
            selectable,
            pos,
            group: 0,
            visible: true,
            gap: 0,
            nonl,
        })
    };

    for k in 0..=n {
        // Lines dropped from the index before index line k+1: present in HEAD
        // and in neither the index nor the worktree, so a staged deletion.
        for (pos, h, text, nonl) in &head_only[k] {
            push("del", text.clone(), Some(*h), None, true, true, *pos, *nonl);
        }
        // Lines the worktree has here that the index does not: an addition
        // that has not been staged.
        for (pos, w, text, nonl) in &work_only[k] {
            push(
                "add",
                text.clone(),
                None,
                Some(*w),
                false,
                true,
                *pos,
                *nonl,
            );
        }

        if k == n {
            break;
        }
        let i = k + 1;
        match (i_to_h[i], i_to_w[i]) {
            (Some(h), Some(w)) => push(
                "context",
                text_of_i[i].clone(),
                Some(h),
                Some(w),
                false,
                false,
                0,
                a_nonl_of_i[i],
            ),
            // In the index and worktree but not HEAD: a staged addition.
            (None, Some(w)) => push(
                "add",
                text_of_i[i].clone(),
                None,
                Some(w),
                true,
                true,
                a_pos_of_i[i],
                a_nonl_of_i[i],
            ),
            // In HEAD and the index but gone from the worktree: a deletion
            // that has not been staged yet.
            (Some(h), None) => push(
                "del",
                text_of_i[i].clone(),
                Some(h),
                None,
                false,
                true,
                b_pos_of_i[i],
                a_nonl_of_i[i],
            ),
            // Only in the index. Reachable by staging a deletion and then
            // restoring the line in the worktree; show it as a staged
            // addition so unchecking it clears the oddity.
            (None, None) => push(
                "add",
                text_of_i[i].clone(),
                None,
                None,
                true,
                true,
                a_pos_of_i[i],
                a_nonl_of_i[i],
            ),
        }
    }

    number_and_fold(&mut rows);
    Ok(rows)
}

/// Assign row ids, group changed runs together, and mark distant unchanged
/// lines as folded.
fn number_and_fold(rows: &mut [Row]) {
    let n = rows.len();
    let changed: Vec<bool> = rows.iter().map(|r| r.kind != "context").collect();

    // Keep anything within CONTEXT lines of a change.
    let mut keep = vec![false; n];
    for (i, c) in changed.iter().enumerate() {
        if !c {
            continue;
        }
        let lo = i.saturating_sub(CONTEXT);
        let hi = (i + CONTEXT).min(n.saturating_sub(1));
        for slot in &mut keep[lo..=hi] {
            *slot = true;
        }
    }

    let mut group = 0usize;
    let mut in_group = false;
    let mut gap = 0usize;
    let mut in_gap = false;

    for (i, row) in rows.iter_mut().enumerate() {
        row.idx = i;

        if changed[i] {
            if !in_group {
                group += 1;
                in_group = true;
            }
            row.group = group;
        } else {
            in_group = false;
        }

        row.visible = keep[i];
        if keep[i] {
            in_gap = false;
        } else {
            if !in_gap {
                gap += 1;
                in_gap = true;
            }
            row.gap = gap;
        }
    }
}

pub fn hash(a: &str, b: &str) -> String {
    let mut h = DefaultHasher::new();
    a.hash(&mut h);
    b.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Fill in a missing side: if HEAD and the index are identical, git prints no
/// diff at all, but the merge still needs an alignment for it.
pub fn context_only_from_index(other: &Align, other_is_b: bool) -> Align {
    let texts = other
        .lines
        .iter()
        .filter(|l| {
            if other_is_b {
                // B's index side is its context and deleted lines.
                matches!(l.op, Op::Ctx | Op::Del)
            } else {
                // A's index side is its context and added lines.
                matches!(l.op, Op::Ctx | Op::Add)
            }
        })
        .map(|l| (l.text.clone(), l.nonl))
        .collect();
    Align::all_context(texts)
}

// ---------------------------------------------------------------- patching

/// Build a single-hunk patch selecting `selected` positions of `align`.
///
/// Forward (`reverse == false`, alignment B) stages the picked lines: the
/// patch's old side is the index, its new side is the index plus those
/// changes. Reverse (alignment A) is applied with `git apply --reverse`, so
/// its *new* side must be the current index.
pub fn build_patch(
    align: &Align,
    selected: &HashSet<usize>,
    reverse: bool,
    path: &str,
) -> Option<String> {
    let mut body = String::new();
    let mut old_count = 0i64;
    let mut new_count = 0i64;
    let mut any = false;

    for (pos, l) in align.lines.iter().enumerate() {
        let sel = selected.contains(&pos);
        let emit = |prefix: char, body: &mut String| {
            body.push(prefix);
            body.push_str(&l.text);
            body.push('\n');
            if l.nonl {
                body.push_str("\\ No newline at end of file\n");
            }
        };

        match l.op {
            Op::Ctx => {
                emit(' ', &mut body);
                old_count += 1;
                new_count += 1;
            }
            Op::Add => {
                if sel {
                    emit('+', &mut body);
                    new_count += 1;
                    any = true;
                } else if reverse {
                    // Staged and staying staged: present on both sides.
                    emit(' ', &mut body);
                    old_count += 1;
                    new_count += 1;
                } else {
                    // Not being staged: absent from the index entirely.
                }
            }
            Op::Del => {
                if sel {
                    emit('-', &mut body);
                    old_count += 1;
                    any = true;
                } else if reverse {
                    // Already gone from the index and staying gone.
                } else {
                    // Deletion not being staged: the line is still in the
                    // index, so it survives as context.
                    emit(' ', &mut body);
                    old_count += 1;
                    new_count += 1;
                }
            }
        }
    }

    if !any {
        return None;
    }

    Some(format!(
        "diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,{old_count} +1,{new_count} @@\n{body}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn align(spec: &[(&str, &str)]) -> Align {
        Align {
            lines: spec
                .iter()
                .map(|(op, text)| AlignLine {
                    op: match *op {
                        " " => Op::Ctx,
                        "-" => Op::Del,
                        _ => Op::Add,
                    },
                    text: text.to_string(),
                    nonl: false,
                })
                .collect(),
            binary: false,
        }
    }

    fn summary(rows: &[Row]) -> Vec<(&'static str, String, bool)> {
        rows.iter()
            .map(|r| (r.kind, r.text.clone(), r.staged))
            .collect()
    }

    #[test]
    fn classifies_each_three_way_case() {
        // HEAD:     keep, gone_staged, gone_unstaged, old
        // index:    keep, gone_unstaged, old, added_staged
        // worktree: keep, old, added_staged, added_unstaged
        let a = align(&[
            (" ", "keep"),
            ("-", "gone_staged"),
            (" ", "gone_unstaged"),
            (" ", "old"),
            ("+", "added_staged"),
        ]);
        let b = align(&[
            (" ", "keep"),
            ("-", "gone_unstaged"),
            (" ", "old"),
            (" ", "added_staged"),
            ("+", "added_unstaged"),
        ]);

        assert_eq!(
            summary(&merge(&a, &b).expect("merge")),
            vec![
                ("context", "keep".into(), false),
                // In HEAD only: already removed from the index.
                ("del", "gone_staged".into(), true),
                // In HEAD and index but not the worktree: not staged yet.
                ("del", "gone_unstaged".into(), false),
                ("context", "old".into(), false),
                // In index and worktree but not HEAD: staged.
                ("add", "added_staged".into(), true),
                // In the worktree only.
                ("add", "added_unstaged".into(), false),
            ]
        );
    }

    #[test]
    fn line_numbers_follow_head_and_worktree() {
        let a = align(&[(" ", "a"), (" ", "b"), (" ", "c")]);
        let b = align(&[(" ", "a"), ("-", "b"), ("+", "B"), (" ", "c")]);
        let rows = merge(&a, &b).expect("merge");

        let got: Vec<_> = rows
            .iter()
            .map(|r| (r.kind, r.old_line, r.new_line))
            .collect();
        assert_eq!(
            got,
            vec![
                ("context", Some(1), Some(1)),
                ("del", Some(2), None),
                ("add", None, Some(2)),
                ("context", Some(3), Some(3)),
            ]
        );
    }

    #[test]
    fn mismatched_index_lengths_are_refused() {
        let a = align(&[(" ", "a")]);
        let b = align(&[(" ", "a"), (" ", "b")]);
        assert!(merge(&a, &b).is_err());
    }

    #[test]
    fn staging_patch_keeps_unpicked_deletions_as_context() {
        let b = align(&[(" ", "a"), ("-", "b"), ("+", "B"), (" ", "c")]);
        // Pick only the addition at position 2.
        let sel: HashSet<usize> = [2].into_iter().collect();
        let p = build_patch(&b, &sel, false, "f.txt").expect("patch");
        assert!(p.contains("@@ -1,3 +1,4 @@\n"), "{p}");
        assert!(p.contains(" b\n"));
        assert!(p.contains("+B\n"));
    }

    #[test]
    fn unstaging_patch_new_side_matches_the_index() {
        // HEAD → index added two lines; take only the first back out.
        let a = align(&[(" ", "a"), ("+", "X"), ("+", "Y"), (" ", "c")]);
        let sel: HashSet<usize> = [1].into_iter().collect();
        let p = build_patch(&a, &sel, true, "f.txt").expect("patch");
        // New side must be the whole index: a, X, Y, c.
        assert!(p.contains("@@ -1,3 +1,4 @@\n"), "{p}");
        assert!(p.contains("+X\n"));
        assert!(p.contains(" Y\n"));
    }

    #[test]
    fn folding_keeps_context_around_changes() {
        let mut spec: Vec<(&str, &str)> = (0..30).map(|_| (" ", "x")).collect();
        spec[15] = ("+", "changed");
        let b = align(&spec);
        let a = align(&spec.iter().map(|_| (" ", "x")).collect::<Vec<_>>()[..29].to_vec());
        let rows = merge(&a, &b).expect("merge");

        let visible: Vec<usize> = rows.iter().filter(|r| r.visible).map(|r| r.idx).collect();
        // The change plus three lines either side.
        assert_eq!(visible, vec![12, 13, 14, 15, 16, 17, 18]);
        assert!(rows.iter().filter(|r| !r.visible).all(|r| r.gap > 0));
    }
}
