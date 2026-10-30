# `/diff` Extension — Implementation Plan

A Pi extension that adds a `/diff` command. It opens a fullscreen custom UI
showing a **side‑by‑side two‑way diff** of every open change in the current
working directory (based on `git`), lets the user navigate across files and
hunks, select a line, and send a prompt about that line back to the agent.

---

## 1. Goals (in priority order)

1. **Primary goal — Visual two‑way diff**
   - Show all open changes in the current working directory.
   - Side‑by‑side (left = old, right = new) with aligned hunk gutters.
   - Fall back to a unified view when the terminal is too narrow.
2. **Primary goal — Navigation**
   - Scroll line by line, page up/down, jump to next/prev hunk, next/prev file.
   - A visible status line showing `file i/N  hunk j/M  line L` and keybinding
     hint.
3. **Primary goal — Line‑based prompting**
   - Select the line under the cursor, optionally extend selection with
     Shift+Up/Down.
   - Press `p` (prompt) to open an input, type a question, and send a user
     message to the agent that embeds the selected line(s) and the file path.
4. **Secondary goal — Session‑scoped changes**
   - If possible, also expose changes done in the *current chat session*
     (derived from the session transcript’s `edit`/`write` tool results).
   - Implemented as a toggle `s` between **git view** and **session view**.
   - Low priority; done after the git view works. See §9.

Non‑goals: three‑way merge, inline edit from the diff view, syntax
highlighting beyond simple ANSI coloring of +/−/context, staging/unstaging.

---

## 2. UX / Keybindings

Fullscreen overlay (`ctx.ui.custom(..., { overlay: false })`, interactive
component — not an overlay, we want to take the whole screen).

```
┌─ /diff  src/foo.ts  (file 2/5 · hunk 1/3 · line 42)  [git · hunks ±3] ──────────────────┐
│    40  const x = 1;        │    40  const x = 1;                             │
│    41  const y = 2;        │    41  const y = 2;                             │
│-   42  const z = 3;        │+   42  const z = 42;                            │
│    43  return x+y+z;       │    43  return x+y+z;                            │
│  ...                       │  ...                                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ j k scroll · n N hunk · Tab file · v select · f full · s source · r refresh · q quit        │
└──────────────────────────────────────────────────────────────────────────────┘
```

Keybindings (ASCII‑only; no bracket characters):

| Key                | Action                                        |
|--------------------|-----------------------------------------------|
| `j` / `↓`          | Cursor down one line                          |
| `k` / `↑`          | Cursor up one line                            |
| `Space` / `PgDn`   | Half‑page down                                |
| `b` / `PgUp`       | Half‑page up                                  |
| `n`                | Next hunk                                     |
| `N`                | Previous hunk                                 |
| `Tab`              | Next file                                     |
| `Shift‑Tab`        | Previous file                                 |
| `g` / `G`          | Jump to top / bottom of current file          |
| `v`                | Toggle line selection (visual mode)           |
| `p`                | Prompt — open input, send message to agent    |
| `s`                | Toggle **git** ↔ **session** source           |
| `f`                | Toggle **hunks** ↔ **full file** view         |
| `+` / `-`          | Increase / decrease context lines (hunks view)|
| `r`                | Refresh (re‑run `git` / rescan session)       |
| `Esc`              | Cancel selection (or quit if no selection)    |
| `q`                | Quit the diff view                            |

The shortcut footer is **always visible at the bottom** of the diff view
(1 fixed row, drawn last after the body). When the view is in a transient
mode (visual selection, prompt input), the footer swaps to a
mode‑appropriate hint but is never hidden:

- Normal:    `j k scroll · n N hunk · Tab file · v select · f full · s source · + - ctx · r refresh · q quit`
- Selecting: `j k extend · p prompt · Esc cancel`
- Prompt:    `Enter send · Esc cancel`

If the footer text is wider than the terminal we `truncateToWidth` it; we
do **not** wrap the footer onto a second line so the body row count stays
predictable.

Note on IME / cursor: the diff view itself does **not** host an `Input`, so it
does not need `Focusable`. The small prompt input that appears for `p` *will*
implement `Focusable` and emit `CURSOR_MARKER` (same pattern as
`overlay-test.ts`).

---

## 3. Data model

```ts
type DiffLineKind = "ctx" | "add" | "del" | "pad"; // pad = blank filler for alignment
type DiffLine = {
  kind: DiffLineKind;
  oldLineNo?: number;       // 1-based, undefined for add/pad
  newLineNo?: number;       // 1-based, undefined for del/pad
  text: string;             // raw line content (no leading +/-/space)
};

type Hunk = {
  oldStart: number; oldLines: number;
  newStart: number; newLines: number;
  header: string;           // e.g. "@@ -40,4 +40,4 @@ function foo()"
  lines: DiffLine[];        // paired/aligned left+right rows
};

type FileDiff = {
  oldPath: string;          // "/dev/null" for added
  newPath: string;          // "/dev/null" for deleted
  displayPath: string;      // best path to show (new else old)
  status: "added" | "deleted" | "modified" | "renamed" | "untracked";
  hunks: Hunk[];
  binary?: boolean;
};
```

A row in the two‑way display is a single `DiffLine` that already contains
either an "old" value, a "new" value, or both:

- `ctx`  → shows on both sides (same text).
- `del`  → shows left only, right is a `pad` filler.
- `add`  → shows right only, left is a `pad` filler.

The `ViewMode` controls how many `ctx` rows surround the `add`/`del` runs:

```ts
type ViewMode =
  | { kind: "hunks"; context: number }   // default: context = 3
  | { kind: "full" };                    // every line of each changed file
```

The parser transforms a raw unified hunk into these aligned rows by walking
`-` and `+` runs and pairing them one‑to‑one (left‑biased: extra `-` lines
pad the right, extra `+` lines pad the left). This is a simple, cheap, and
good‑enough alignment that avoids pulling in a diff library.

---

## 4. Data sources

### 4.1 Git source (primary)

Use `git` via `child_process.execFile` with `cwd = ctx.cwd`.

1. **Discover repo**: `git -C <cwd> rev-parse --show-toplevel`. If this
   fails, show an error notification and exit.
2. **Tracked, uncommitted changes**: `git diff --no-color --no-ext-diff
   --unified=<N> HEAD`, where `<N>` is:
   - the current context setting (`3` by default, adjustable with `+`/`-`) in
     **hunks** mode, and
   - a very large number (we use `--unified=1000000`, which Git treats as
     "show the entire file") in **full file** mode.
   This covers staged + unstaged vs. last commit — matches "all open
   changes" better than plain `git diff`.
3. **Untracked files**: `git ls-files --others --exclude-standard`, and for
   each, synthesize a `FileDiff` where the left side is `/dev/null` and the
   right side is the file content (read with Node `fs`, capped at e.g. 2 MB
   per file; larger files are shown as a single `"<binary or too large>"`
   stub). An untracked file is "all added" in both views; the full‑file
   switch doesn't change what it shows.
4. If there’s no `HEAD` yet (fresh repo), fall back to `git diff --cached`
   plus `git diff` plus untracked.
5. **Switching view modes is cheap**: we keep the raw diff outputs for both
   `--unified=3` (initial) and `--unified=1000000` cached per refresh, and
   re‑parse into `FileDiff[]` lazily when the user toggles. Re‑running `git`
   only happens on `r` (refresh) or when the user adjusts the context
   setting beyond what we have cached.

Parse the output with a small hand‑written unified‑diff parser (there is no
value in a dependency here, and the extension stays dependency‑free).

### 4.2 Session source (secondary, nice‑to‑have)

Walk `ctx.sessionManager.getBranch()` and collect tool results for the
built‑in `edit` and `write` tools. For each file:

- `write` → treat as a full replacement; synthesize a diff of the *original
  on‑disk* content (before the session) vs. the written content.
- `edit`  → the tool result exposes before/after snippets in `details`;
  accumulate them per file.

Because the tool result shape is specific to Pi’s internals and may vary,
this view will be best‑effort: when the needed data isn’t available in
`details`, show a single stub line explaining why. The primary and more
robust answer to “what changed in this session” is `git` itself, so this
toggle is mainly convenience.

---

## 5. Component architecture

```
diffExtension (index.ts)
├── registerCommand("diff", handler)
├── git.ts            — exec git, parse unified diff, build FileDiff[]
├── session.ts        — build FileDiff[] from session branch (optional)
├── align.ts          — pair +/- lines into aligned DiffLine rows
├── render.ts         — pure functions: render a FileDiff slice to lines
└── ui/
    ├── DiffViewComponent.ts   — main fullscreen component
    └── PromptInput.ts         — tiny Focusable input used by `p`
```

Rendering is driven by a cached list of **virtual rows** per file (header
rows + hunk header rows + diff rows). The component keeps:

- `files: FileDiff[]`
- `fileIndex`, `rowIndex` (cursor), `scrollTop`
- `selection: { anchorRow, cursorRow } | null`
- `source: "git" | "session"`
- Cached `lines: string[]` per (width, fileIndex, scrollTop, cursorRow,
  selection, theme‑epoch), invalidated via `invalidate()` as per `tui.md`.

Width handling uses `visibleWidth`, `truncateToWidth`, `sliceByColumn`
exclusively. We never call `.length` on styled strings.

### Layout math

Given terminal `width`:

- If `width >= 100`: side‑by‑side. Each pane width is
  `Math.floor((width - 1 /*divider*/ - 2 /*outer*/) / 2)`. Line numbers
  take 5 cols + 1 sign col + 1 space on each side.
- Else: unified view — one column, +/−/space in the sign col.

Height: use the full available area the TUI gives the component. Header
row (file info) + body + footer (keybinding hint) = fixed 1 + body + 1.

---

## 6. Sending a prompt from a selected line

When the user presses `p`:

1. Capture the current selection (or the single cursor line if no selection).
2. Build a context block:
   ```
   File: src/foo.ts  (lines 42–45, new side)
   ```ts
   const z = 42;
   return x + y + z;
   ```
   ```
3. Show a small single‑line `PromptInput` overlay (bordered box, focused,
   `CURSOR_MARKER` emitted). `Esc` cancels, `Enter` submits.
4. On submit, close the diff view (`done(undefined)`) **first**, then call
   `pi.sendUserMessage(contextBlock + "\n\n" + userText)` from the command
   handler. This matches the pattern in `send-user-message.ts`.
5. If the agent is busy (`!ctx.isIdle()`), use `{ deliverAs: "followUp" }`
   and notify the user that the message was queued.

Rationale for closing the view first: the diff component owns the
interactive area; after `sendUserMessage` the agent will stream output
into the normal transcript, which is only visible when we release control.

---

## 7. Error handling & edge cases

- Not a git repo → notify, abort.
- Repo clean (no changes, no untracked) → notify "No open changes.", abort.
- Binary files (detected by `git diff` marker) → single row "Binary file".
- Very long lines → truncate to pane width, show `…` and remember full
  content so prompt mode still sends the full line.
- Very large diffs (> N files or > M total rows) → still work; rendering is
  O(visible rows), not O(total rows), because we only format the visible
  slice.
- Narrow terminal (`width < 60`) → unified single‑column fallback.
- Theme change → caches are cleared by the TUI; `invalidate()` resets our
  own.

---

## 8. Testing / manual QA checklist

Run against this very repo (which will have at least `PLAN.md` as an
untracked file after Step 1, giving us a known fixture):

- [ ] `/diff` opens, shows `PLAN.md` as an added/untracked file.
- [ ] Modify an existing tracked file, re‑run → shows modified hunk.
- [ ] Delete a tracked file → shows deleted file diff.
- [ ] Navigate across files with `}` / `{`, across hunks with `]` / `[`.
- [ ] Select a few lines with `v` + `j`, press `p`, type a question,
      verify the agent receives a message containing those lines.
- [ ] Resize terminal across the 100‑col threshold → layout switches
      between side‑by‑side and unified cleanly.
- [ ] `f` toggles to full‑file view → every line of a changed file is
      visible with changed lines still highlighted; navigation (`]`/`[`,
      `}`/`{`) still works and jumps between change regions.
- [ ] `+` / `-` change the context lines in hunks view (clamped to
      `[0, 20]`); large values eventually equal the full‑file view.
- [ ] Non‑git directory → clear error message.
- [ ] `t` toggles to session view; shows at minimum a stub when session
      data is insufficient.

---

## 9. Milestones

1. **M1 — Scaffolding (small).** `package.json`, `tsconfig.json`,
   `index.ts` with `/diff` command that just notifies "hello". Verify
   it loads via `pi --extension ./index.ts`.
2. **M2 — Git parsing.** `git.ts` + `align.ts` + a tiny CLI harness
   (`node --import tsx bin/dump.ts`) that prints the parsed structure.
   No UI yet.
3. **M3 — Side‑by‑side renderer.** `render.ts` producing ANSI lines for
   a `FileDiff`, no interactivity. Dump to stdout for visual inspection.
4. **M4 — Interactive component.** `DiffViewComponent` with scroll,
   file/hunk navigation, status line, footer. Side‑by‑side + unified
   fallback.
5. **M5 — View modes.** Add the `f` toggle between **hunks** and **full
   file**, and `+`/`-` to change context lines in hunks mode. Status line
   shows the current mode, e.g. `[git · full]` or `[git · hunks ±3]`.
6. **M6 — Selection + prompt.** Visual selection, `PromptInput`, wire
   `pi.sendUserMessage`.
7. **M7 — Session‑source toggle (if time permits).** Walk the branch,
   build best‑effort `FileDiff[]`, `t` to toggle.
8. **M8 — Polish.** Error cases, theme usage via `theme.fg/style`,
   `README.md` for the extension, screenshot/gif.

---

## 10. Review of this plan (self‑critique)

- **Alignment algorithm is naive.** A per‑run `-`/`+` pairing isn’t a
  true LCS. For small hunks (the common case in interactive review)
  this is fine; if it ever looks wrong we can swap in a `diff` library
  behind the same `align.ts` interface without touching the UI.
- **Session source might disappoint.** Pi’s tool‑result `details` are
  not a stable public schema. We’ll keep the git view authoritative
  and make the session toggle a best‑effort convenience, flagged in the
  footer as `[session]` with a note when data is partial.
- **Fullscreen vs. inline.** We render as a focused interactive
  component (not an overlay) because diffs need the whole viewport.
  `tui.md` warns that focused overlays retain input across renders;
  since we are *not* an overlay, exiting via `done(...)` cleanly
  returns control to the editor.
- **Prompt UX.** Opening a nested overlay from inside the diff view is
  tempting but adds focus‑management complexity. Instead, we exit the
  diff first and send a `sendUserMessage` with the captured snippet.
  The user sees the message appear in the normal transcript — standard
  pi behavior, nothing surprising.
- **No external deps.** We stay dependency‑free. All diff parsing,
  alignment, width handling (`visibleWidth`, `truncateToWidth`,
  `sliceByColumn`) comes from `@earendil-works/pi-tui`.
- **Keep rendering responsive** (per `tui.md`): we cache lines by
  `(width, fileIndex, scrollTop, cursorRow, selection)` and only
  recompute on state change.

If this plan looks good, I will start at **M1**.
