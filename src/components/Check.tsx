import type { StagedState } from "../api";

/** Tri-state checkbox: unchecked, dash (partially staged), tick. */
export function Check({
  state,
  onClick,
  title,
  disabled,
}: {
  state: StagedState;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <span
      className={`check check-${state}${disabled ? " disabled" : ""}`}
      role="checkbox"
      aria-checked={state === "all" ? "true" : state === "partial" ? "mixed" : "false"}
      aria-disabled={disabled}
      title={title}
      onClick={disabled ? undefined : onClick}
    >
      {state === "all" && (
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M10 3 4.6 8.4 2 5.8" fill="none" strokeWidth="1.8" />
        </svg>
      )}
      {state === "partial" && (
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 6h6" fill="none" strokeWidth="1.8" />
        </svg>
      )}
    </span>
  );
}
