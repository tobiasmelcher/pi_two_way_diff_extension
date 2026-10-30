# pi-two-diff-extension

A [Pi](https://github.com/earendil-works/pi) extension that adds a **`/diff`** slash command: a
file-picker over all open changes in the current working directory, followed by
a two-pane side-by-side diff view with navigation and line-based prompting to
the agent.

- Lists tracked changes immediately, then adds untracked files after a
  background scan completes
- Press `/` in the file list for a lazy-loaded, search-as-you-type picker over
  Git-tracked and non-ignored untracked files, including unchanged files
- Side-by-side diff view that falls back to unified on narrow terminals
- Java source files (`.java`) receive lightweight syntax coloring for keywords,
  strings, annotations, literals, and comments
- Press `l` to temporarily hide/show the old (left) pane and give the new/source pane the full width
- Press `Ctrl+g` to jump directly to a source line number
- Toggle between **hunks** (default) and **full-file** view
- Grow/shrink surrounding context with `+` / `-`
- **Color-blind safe**: cursor and selection use a visible left-column glyph
  (`▶`, `█`) in addition to inverse video / underline / bold — no reliance on
  color
- **Mouse support**: wheel to scroll, click to place the cursor, double-click
  in the file list to open a file. `Shift+wheel` in the diff view scrolls
  horizontally for long source lines.
- Select one or more lines, press `p`, type a question, and the extension sends
  a `pi.sendUserMessage` with the snippet (file + line range) and your question
- Zero npm dependencies — pure TypeScript, uses only `@earendil-works/pi-tui`
  and Node's built-ins

See [`PLAN.md`](./PLAN.md) for the full design doc.

---

## Install

Pi loads extensions as plain TypeScript or JavaScript — no build step. Pick
one of the following, depending on how often you want to use it.

### A. One-off (dev / try it out)

Run Pi with the `--extension` flag, pointing at the local file:

```bash
cd /path/to/pi_two_diff_extension
pi --extension ./index.ts
```

### B. Always available in your user account

Symlink (or copy) the project folder into your Pi user extensions directory:

```bash
# ~/.pi/extensions/ by default, or $PI_CODING_AGENT_DIR/extensions/
mkdir -p ~/.pi/extensions
ln -s "$(pwd)" ~/.pi/extensions/pi-two-diff-extension
```

Then just start Pi normally:

```bash
pi
```

Pi auto-discovers directories under `~/.pi/extensions/` that contain an
`index.ts` (or an `index.js`), so the symlink is enough. After adding or
updating it, run `/reload` inside Pi to pick up changes.

### C. Only for one project

Drop a symlink into the project's `.pi/extensions/` directory:

```bash
mkdir -p .pi/extensions
ln -s /path/to/pi_two_diff_extension .pi/extensions/pi-two-diff-extension
```

Project extensions require project trust (Pi will prompt the first time).

### Verify it's loaded

Start Pi and type `/` — the autocomplete list should show `/diff — Show a
two-way diff of open changes with navigation and line-based prompting`.

> **Requirements:** Pi ≥ 1.4, Node ≥ 20, and `git` on `PATH`. The extension
> works in interactive (TUI) mode only; in `--print` or RPC/JSON modes it
> notifies you and exits.

---

## Using `/diff`

The command runs in two linked views: a **file list** and a **diff view**.

### 1. File list (opens first)

```
/diff (14 files)                                              [git · hunks ±3]
▶  [M]  PLAN.md                                               +1 -0
   [+]  src/foo.ts                                            +42 -3
   [?]  src/bar.ts                                            +120 -0
   [-]  old-stuff.ts                                          +0 -58
   ...
 j k move · Enter open · / find file · f full · s source · + - ctx · r refresh · q quit
```

The leading badge tells you what changed:

| Badge | Meaning            |
|-------|--------------------|
| `[M]` | modified           |
| `[+]` | added (tracked)    |
| `[?]` | untracked          |
| `[-]` | deleted            |
| `[R]` | renamed            |
| `[ ]` | unchanged file opened through `/` search |

Right of each path, `+N -M` shows added and removed line counts. The initial
list shows tracked changes first; untracked files are added when the background
scan completes. While that scan runs, the header says `scanning untracked…`.

#### Keys (file list)

| Key                 | Action                             |
|---------------------|------------------------------------|
| `j` / `↓`           | Move cursor down                   |
| `k` / `↑`           | Move cursor up                     |
| `Space` / `PgDn`    | Half page down                     |
| `b` / `PgUp`        | Half page up                       |
| `g` / `Home`        | Jump to top                        |
| `G` / `End`         | Jump to bottom                     |
| `Enter`             | Open the diff view for this file   |
| `/`                 | Search every working-tree file and open a match |
| `?`                 | Incrementally search text in tracked files and open a match |
| `f`                 | Toggle **hunks ↔ full file** view  |
| `+` / `-`           | More / fewer context lines         |
| `s`                 | Toggle git ↔ session source *(session WIP)* |
| `r`                 | Refresh (re-run `git`)             |
| `q` / `Esc`         | Exit `/diff`                       |

**Mouse** (fullscreen mode): wheel scrolls the file list without moving the
selection; single click selects a file; double-click on the selected file
opens it. After wheel-scrolling, click a visible row to re-anchor the
selection cursor.

**Find any file with `/`**: from the file list, press `/` to open the same
search-as-you-type picker used for source search. Its Git-backed file index is
loaded lazily the first time you press `/`, so it does not delay opening
`/diff`. It indexes Git-tracked and non-ignored untracked files under the working directory, not just files with
open changes (so ignored build/dependency directories do not delay opening
`/diff`). The initial diff list appears before its separate untracked-file scan
finishes. Type part of a path (with optional `*` wildcards), use `↑`/`↓` to choose a match, and press
`Enter` to open it. Unchanged text files open as a full-file two-way view with
identical old and new panes.

**Find text with `?`**: from the file list, press `?` for an incremental
full-text search of Git-tracked text files. Results appear in the same
search-as-you-type panel as Git streams them, so large repositories remain
responsive. Searches are debounced while typing, stale searches are ignored,
and streamed matches are batched before rendering; results are capped at 1,000
to keep memory and rendering bounded. `Enter` opens the matched file **at the matching
line**; press `h` or `Esc` from the diff view to return to the same text-search
query, cached result list, and selected match without rerunning Git. The query
supports smart case and
`*` wildcards, with every other character treated literally. Starting a new
query cancels the prior Git search. Untracked files are not included in this
content search, because Git's indexed `git grep` is used for speed.

### 2. Diff view (one file)

```
/diff  src/foo.ts  (file 2/14 · hunk 1/3)                     [git · hunks ±3]
    40  const x = 1;        │    40  const x = 1;
    41  const y = 2;        │    41  const y = 2;
▶ - 42  const z = 3;        │+   42  const z = 42;
    43  return x+y+z;       │    43  return x+y+z;
   …
 j k scroll · n N change · Tab file · h back · v select · p prompt · f full · s source · + - ctx · r refresh · q quit
```

The left pane is the **old** state, the right pane is the **new** state. On
narrow terminals (< 100 columns) the view falls back to unified single-column.
For Java files, a lightweight single-pass highlighter colors keywords,
strings/characters, annotations, `true`/`false`/`null`, and comments in
unchanged context lines. Added and deleted lines deliberately retain their
strong diff colors so syntax coloring cannot make either side hard to read. It does
not parse Java or load a syntax-highlighting dependency, keeping scrolling and
rendering inexpensive.

#### Visual cues (work without color — important for color-blind users)

| Row state              | Left marker | Also styled with   |
|------------------------|-------------|--------------------|
| Normal                 | `  `        | —                  |
| Cursor                 | `▶ `        | inverse + bold     |
| Selected               | `█ `        | underline + bold   |
| Cursor + selected      | `▶█`        | inverse + bold     |

#### Keys (diff view)

| Key                | Action                                                 |
|--------------------|--------------------------------------------------------|
| `j` / `↓`          | Cursor down one line                                   |
| `k` / `↑`          | Cursor up one line                                     |
| `←` / `→`          | Horizontal scroll left / right (for long source lines) |
| `Home`             | Reset horizontal scroll                                |
| `Space` / `PgDn`   | Half page down                                         |
| `b` / `PgUp`       | Half page up                                           |
| `n` / `N`          | Next / previous **change region** (add/del block)      |
| `Tab` / `Shift-Tab`| Next / previous file (stays in diff view)              |
| `g` / `G`          | Top / bottom of current file                           |
| `h` / `Esc`        | Back to file list                                      |
| `v`                | Toggle visual (line) selection                         |
| `p`                | **Prompt** — ask the agent about the selected lines    |
| `f`                | Toggle **hunks ↔ full file** view                      |
| `l`                | Hide/show the old (left) pane for a full-width new/source pane |
| `Ctrl+g`           | Jump to a source line number                              |
| `s`                | Toggle git ↔ session source *(session WIP)*            |
| `+` / `-`          | More / fewer context lines (hunks mode)                |
| `r`                | Refresh                                                |
| `q`                | Quit `/diff` entirely                                  |

**Mouse** (fullscreen mode):

| Action                              | Effect                                                       |
|-------------------------------------|--------------------------------------------------------------|
| Wheel up / down                     | Scrolls the viewport only; the cursor stays put              |
| Left click on a body row            | Places the cursor on the clicked line (also works to re-anchor the cursor after wheel-scrolling it off-screen) |
| `Shift` + wheel                     | Horizontal scroll (for long source lines)                    |
| Wheel in the `/` search panel       | Navigate matches                                             |
| Click a row in the `/` search panel | Jump to that match (same as Enter)                           |

**`l` temporarily hides the old (left) pane** in the wide, side-by-side
layout and expands the new/source (right) pane to the available width. Press
`l` again to restore the two-pane comparison. The header displays `new only`
while this mode is active. On a narrow terminal the diff is already unified,
so the toggle has no visual effect until the terminal is wide enough.

**`Ctrl+g` opens a `Go to line:` input**. Enter a 1-based line number to
jump to that line in the new/source file. From hunks view, the extension
first expands the file to full view so lines outside visible hunks can be
reached. A deleted line has no new/source location and cannot be selected.

Mouse behavior requires your terminal to be in fullscreen mode, which pi
enables automatically while the diff view is open. Keyboard navigation
keys (`j`, `k`, `n`, `N`, `g`, `G`, …) still auto-scroll the viewport to
keep the cursor visible — only the wheel is "free scrolling".

When the view is horizontally scrolled, the top-right indicator shows the
current column offset, e.g. `[git · hunks ±3 · col +30]`. The line-number
and `+`/`-` gutter never scrolls; only the source text does.

The footer at the bottom always shows the keys relevant to the current
mode (normal, visual-selection, or prompt), so you don't need to remember
them.

### 3. Sending a prompt about selected lines

1. Move the cursor to a line of interest.
2. (Optional) press `v`, then `j`/`k` to extend the selection across more
   lines. `Esc` cancels the selection.
3. Press `p`. The footer becomes a single-line input prefixed with
   `Ask about this snippet:`.
4. Type your question and press `Enter`.

The extension closes the diff view and sends a user message that looks like:

~~~
In `src/foo.ts` (lines 42–45):
```
- const z = 3;
+ const z = 42;
  return x + y + z;
```

Why did we change the formula here?
~~~

If the agent is currently streaming a response, the message is queued as a
follow-up instead (via `sendUserMessage(..., { deliverAs: "followUp" })`),
and you get a toast confirming it was queued.

### 4. Search inside the source (`/`)

Press `/` in the diff view to open a **search-as-you-type** panel at the
bottom of the screen:

```
┌──────────────────────────────────────────────────────┐
/ unified                                           3/11 │
├──────────────────────────────────────────────────────┤
   2 +  … parses `unified` diff into FileDiff[]      │
   6 +  … diff --no-color --`unified`=<N> HEAD`      │
▶ 54 +    let `unified` = "";                        │
  65 +  …--no-ext-diff", `--`unified`=${context}`, … │
  69 +      `unified` = stdout;                       │
└─────────────────── Enter jump · ↑↓ navigate · Esc cancel ┘
```

- **Live-updating** match list: filtered on every keystroke, as a substring
  of each source line.
- **Wildcards**: `*` matches any string of any length (including empty), so
  `MultiPage*.java` matches `MultiPage.java` and `MultiPager.java`. It is the
  only pattern operator; all other characters are matched literally. This
  applies to both source and file-path search.
- **Smart case**: all-lowercase query = case-insensitive; any uppercase in
  the query = case-sensitive (same convention as vim / ripgrep).
- **Full source**: `/` searches every line of the file, not just the
  visible hunks. If you were in hunks view when you pressed `/`, the view
  automatically expands to full-file first so the match is always
  reachable afterwards.
- **Match highlighting**: in the list, the matched substring is drawn
  with inverse video + bold (color-blind safe). The selected row shows the
  `▶ ` cursor marker + inverse + bold.
- **Navigate matches** with `↑` / `↓` (or `PgUp` / `PgDn`).
- **Enter** closes the panel and places the diff cursor on the matched
  line. `Esc` cancels without moving.
- The counter in the input bar shows `current/total`, e.g. `3/11`.

While the panel is open the diff body stays visible and its cursor row
updates live to follow the currently selected match, so you can see the
context of each match without pressing Enter.

### View-mode details

- **Hunks (default)**: standard git diff with `±N` surrounding context lines.
  `+` / `-` steps through the ladder `[0, 1, 2, 3, 5, 8, 12, 20]`.
- **Full file**: shows every line of each changed file, with the add/del
  blocks highlighted in context. Internally this runs `git diff --unified=1000000`.
  Toggle with `f`. Untracked files look the same in both modes (they are all
  additions by definition).

The current mode is always visible in the top-right status, e.g.
`[git · full]` or `[git · hunks ±3]`.

---

## Known limitations / roadmap

- **Session-scoped diff (`s` toggle)** is not implemented yet; it currently
  shows "Session source not yet available". Git view covers the common case
  ("what changed in my working tree, regardless of origin").
- **Alignment** uses a simple left-biased 1:1 pairing of `-`/`+` runs rather
  than a true LCS. It's fine for interactive review but can look suboptimal
  on large block replacements; a drop-in replacement in `src/align.ts` is
  easy to swap in later.
- Java syntax coloring is intentionally lightweight and line-oriented; it does
  not track multi-line lexical state or provide semantic highlighting.
- Mouse input is supported in fullscreen mode; regular terminal mode leaves
  mouse input to the terminal for scrollback and text selection.

See [`PLAN.md`](./PLAN.md) §9 for the planned milestones.

---

## Development

### Type-check

```bash
npm run check          # runs: npx tsc --noEmit (uses the symlinked pi types)
```

### Tests

```bash
npm test               # run the whole suite once
npm run test:watch     # re-run on file changes
./scripts/test.sh tests/align.test.ts   # just one file
```

The test suite uses **Node's built-in `node:test` runner** + `node:assert`,
with `jiti` (bundled by `@earendil-works/pi-coding-agent`) as the TypeScript
loader — so no extra npm dependencies are needed to run tests.

Current coverage (61 tests across 5 modules):

| File                             | What it covers                                                            |
|----------------------------------|---------------------------------------------------------------------------|
| `tests/align.test.ts`            | `alignHunkLines`, `pairIntoRows`: ctx/add/del pairing, line-number math    |
| `tests/git.test.ts`              | `parseUnifiedDiff`: modified / added / deleted / renamed / binary / multi, hunk-header defaults, `\ No newline` markers |
| `tests/render.test.ts`           | `buildVirtualRows`, Java syntax highlighting, `renderDiffViewport`, horizontal scroll, regression test for the long-line truncation / highlight bug |
| `tests/search-panel.test.ts`     | `SearchPanel` typing/filtering, smart-case, wildcard matching, Enter / Esc / arrow keys, bordered-panel render |
| `tests/mouse.test.ts`            | File-list and diff-view mouse behavior, lazy file search, incremental full-text search, line jumping, pane toggling |

Adding a new test is just dropping a `tests/*.test.ts` file; the runner
picks it up automatically. For helpers (fake theme / TUI stand-ins) see
`tests/helpers.ts`.

### Smoke test the parser against a live repo

If you want to see what `parseUnifiedDiff` produces for the current repo,
any script that imports `./src/git.ts` and runs through jiti works:

```bash
node \
  "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-cli.mjs" \
  ./scripts/dev-dump.ts   # if you add one
```

Project layout:

```
pi_two_diff_extension/
├── index.ts                      /diff command + list ↔ diff flow
├── src/
│   ├── types.ts                  FileDiff, Hunk, ViewMode, …
│   ├── git.ts                    exec git + parse unified diff
│   ├── align.ts                  pair -/+ runs into side-by-side rows
│   ├── render.ts                 virtual-row builder + ANSI renderer
│   └── ui/
│       ├── FileListComponent.ts  entry-point file picker
│       ├── DiffViewComponent.ts  the two-pane diff view
│       ├── SearchPanel.ts        / search-as-you-type panel
│       └── PromptInput.ts        focusable one-line input for `p`
├── tests/
│   ├── helpers.ts                shared test helpers (fake theme / TUI)
│   ├── align.test.ts
│   ├── git.test.ts
│   ├── render.test.ts
│   └── search-panel.test.ts
├── scripts/
│   └── test.sh                   node --test + jiti loader
├── PLAN.md
├── README.md
└── package.json
```

The code uses only `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, and `node:` built-ins. No `npm install` required for
users; the dev symlinks in `node_modules/` are only there so TypeScript can
resolve the Pi types during local type-checking.
