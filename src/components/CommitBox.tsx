import type { CommitInfo } from "../api";

export function CommitBox({
  summary,
  description,
  onSummary,
  onDescription,
  onCommit,
  stagedCount,
  branch,
  busy,
  last,
}: {
  summary: string;
  description: string;
  onSummary: (v: string) => void;
  onDescription: (v: string) => void;
  onCommit: () => void;
  stagedCount: number;
  branch: string | null;
  busy: boolean;
  last: CommitInfo | null;
}) {
  const canCommit = summary.trim().length > 0 && stagedCount > 0 && !busy;

  // ⌘↵ from either field commits, the same shortcut GitHub Desktop uses.
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
      e.preventDefault();
      onCommit();
    }
  };

  return (
    <div className="commitbox">
      <input
        className="summary"
        placeholder="Summary (required)"
        value={summary}
        onChange={(e) => onSummary(e.target.value)}
        onKeyDown={onKey}
      />
      <textarea
        className="description"
        placeholder="Description"
        rows={3}
        value={description}
        onChange={(e) => onDescription(e.target.value)}
        onKeyDown={onKey}
      />
      <button className="commit" disabled={!canCommit} onClick={onCommit}>
        {stagedCount === 0
          ? "Nothing staged"
          : `Commit ${stagedCount} file${stagedCount === 1 ? "" : "s"}${
              branch ? ` to ${branch}` : ""
            }`}
      </button>
      {last && (
        <div className="lastcommit" title={last.subject}>
          <span className="lc-when">Committed {last.relative}</span>
          <span className="lc-subject">{last.subject}</span>
        </div>
      )}
    </div>
  );
}
