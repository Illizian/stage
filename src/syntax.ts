import { useEffect, useMemo, useState } from "react";
import {
  bundledLanguages,
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
} from "shiki";
import type { DiffRow, FileDiff } from "./api";

export interface Tok {
  content: string;
  color?: string;
}

/** Above this, highlighting costs more than it is worth. */
const MAX_LINES = 8000;

/** Extensions whose language id differs from the extension itself. */
const EXT: Record<string, string> = {
  mjs: "javascript",
  cjs: "javascript",
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  pyi: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  kt: "kotlin",
  kts: "kotlin",
  rlib: "rust",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  cs: "csharp",
  m: "objective-c",
  mm: "objective-cpp",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ksh: "shellscript",
  ps1: "powershell",
  psm1: "powershell",
  yml: "yaml",
  md: "markdown",
  mdx: "mdx",
  rst: "rst",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "hcl",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  clj: "clojure",
  cljs: "clojure",
  edn: "clojure",
  pl: "perl",
  pm: "perl",
  r: "r",
  jl: "julia",
  svg: "xml",
  xsd: "xml",
  plist: "xml",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  gradle: "groovy",
  properties: "ini",
  conf: "ini",
  cfg: "ini",
  env: "dotenv",
  gitignore: "ignore",
  dockerignore: "ignore",
  npmignore: "ignore",
  proto: "proto",
  graphql: "graphql",
  gql: "graphql",
  sol: "solidity",
  zig: "zig",
  nim: "nim",
  dart: "dart",
  lua: "lua",
  sql: "sql",
  php: "php",
  java: "java",
  scala: "scala",
  swift: "swift",
  toml: "toml",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  c: "c",
  cpp: "cpp",
  vim: "viml",
  fish: "fish",
  nix: "nix",
  tex: "latex",
  bib: "bibtex",
  csv: "csv",
  diff: "diff",
  patch: "diff",
};

/** Files identified by name rather than extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  containerfile: "docker",
  makefile: "make",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  brewfile: "ruby",
  procfile: "shellscript",
  "cargo.lock": "toml",
  "go.mod": "go-module",
  "go.sum": "ini",
  ".babelrc": "json",
  ".prettierrc": "json",
};

export function langForPath(path: string): BundledLanguage | null {
  const name = (path.split("/").pop() ?? "").toLowerCase();

  const named = BY_NAME[name];
  if (named && named in bundledLanguages) return named as BundledLanguage;

  const dot = name.lastIndexOf(".");
  // A leading dot is part of the name (".gitignore"), not an extension marker.
  const ext = dot > 0 ? name.slice(dot + 1) : name.replace(/^\./, "");
  if (!ext) return null;

  const id = EXT[ext] ?? ext;
  return id in bundledLanguages ? (id as BundledLanguage) : null;
}

let shared: Promise<Highlighter> | null = null;

function highlighter(): Promise<Highlighter> {
  if (!shared) {
    shared = createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: [],
    });
  }
  return shared;
}

async function tokenize(
  code: string,
  lang: BundledLanguage,
  theme: string,
): Promise<Tok[][]> {
  const hl = await highlighter();
  if (!hl.getLoadedLanguages().includes(lang)) {
    await hl.loadLanguage(lang);
  }
  const { tokens } = hl.codeToTokens(code, { lang, theme });
  return tokens.map((line) => line.map((t) => ({ content: t.content, color: t.color })));
}

interface Syntax {
  /** Tokens for a row, or null when the file is not highlighted. */
  tokensFor: (row: DiffRow) => Tok[] | null;
}

/**
 * Syntax-highlight a diff.
 *
 * Both whole files are reconstructed from the rows and tokenised as complete
 * documents, so a line inside a multi-line string or comment is coloured with
 * the context it actually has. Deleted lines come from the HEAD side and
 * everything else from the worktree side.
 */
export function useSyntax(diff: FileDiff | null): Syntax {
  const [dark, setDark] = useState(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(m.matches);
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, []);

  const lang = useMemo(() => (diff ? langForPath(diff.path) : null), [diff?.path]);

  // Keyed on the text itself, so staging a line — which changes the rows but
  // not a single character of either file — does not re-highlight.
  const { oldText, newText } = useMemo(() => {
    if (!diff) return { oldText: "", newText: "" };
    const o: string[] = [];
    const n: string[] = [];
    for (const r of diff.rows) {
      if (r.oldLine != null) o.push(r.text);
      if (r.newLine != null) n.push(r.text);
    }
    return { oldText: o.join("\n"), newText: n.join("\n") };
  }, [diff]);

  const [result, setResult] = useState<{
    key: string;
    oldLines: Tok[][];
    newLines: Tok[][];
  } | null>(null);

  const theme = dark ? "github-dark" : "github-light";
  const key = `${diff?.path ?? ""}|${theme}|${oldText.length}|${newText.length}`;

  useEffect(() => {
    if (!lang || !diff) {
      setResult(null);
      return;
    }
    const lines = Math.max(oldText.length, newText.length);
    if (lines === 0 || diff.rows.length > MAX_LINES) {
      setResult(null);
      return;
    }

    let cancelled = false;
    Promise.all([
      oldText ? tokenize(oldText, lang, theme) : Promise.resolve([]),
      newText ? tokenize(newText, lang, theme) : Promise.resolve([]),
    ])
      .then(([oldLines, newLines]) => {
        if (!cancelled) setResult({ key, oldLines, newLines });
      })
      .catch(() => {
        // An unsupported grammar just means plain text.
        if (!cancelled) setResult(null);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, theme, oldText, newText]);

  return useMemo(() => {
    const r = result?.key === key ? result : null;
    return {
      tokensFor: (row: DiffRow) => {
        if (!r) return null;
        if (row.newLine != null) return r.newLines[row.newLine - 1] ?? null;
        if (row.oldLine != null) return r.oldLines[row.oldLine - 1] ?? null;
        return null;
      },
    };
  }, [result, key]);
}
