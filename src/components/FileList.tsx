import { splitPath, statusLetter, type FileEntry } from "../api";
import { Check } from "./Check";

export function FileList({
  files,
  selected,
  onSelect,
  onToggle,
  onToggleAll,
}: {
  files: FileEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
  onToggle: (f: FileEntry) => void;
  onToggleAll: (stageEverything: boolean) => void;
}) {
  const stagedCount = files.filter((f) => f.stagedState !== "none").length;
  const allState =
    stagedCount === 0 ? "none" : stagedCount === files.length ? "all" : "partial";

  return (
    <div className="filelist">
      <div className="list-head">
        <Check
          state={allState}
          title={allState === "all" ? "Unstage everything" : "Stage everything"}
          onClick={() => onToggleAll(allState !== "all")}
        />
        <span>
          {files.length} changed file{files.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="rows" role="listbox" aria-label="Changed files">
        {files.map((f) => {
          const [dir, name] = splitPath(f.path);
          const letter = statusLetter(f);
          return (
            <div
              key={f.path}
              role="option"
              aria-selected={f.path === selected}
              className={`frow${f.path === selected ? " sel" : ""}`}
              onClick={() => onSelect(f.path)}
            >
              <Check
                state={f.stagedState}
                title={
                  f.stagedState === "all"
                    ? "Unstage this file"
                    : "Stage this whole file"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(f);
                }}
              />
              <span className="fpath" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
                <span className="fdir">{dir}</span>
                <span className="fname">{name}</span>
              </span>
              <span className={`badge b-${letter}`} title={describe(f)}>
                {letter}
              </span>
            </div>
          );
        })}

        {files.length === 0 && <div className="empty-list">No local changes</div>}
      </div>
    </div>
  );
}

function describe(f: FileEntry): string {
  if (f.unmerged) return "Conflicted";
  if (f.untracked) return "New file (untracked)";
  const parts: string[] = [];
  if (f.indexStatus !== ".") parts.push(`staged: ${f.indexStatus}`);
  if (f.workStatus !== ".") parts.push(`unstaged: ${f.workStatus}`);
  return parts.join(", ");
}
