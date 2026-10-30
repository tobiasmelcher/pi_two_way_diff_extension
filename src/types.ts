/**
 * Shared data types for the /diff extension.
 */

export type DiffSource = "git" | "session";

/** A view mode controls how many context lines surround the +/- runs. */
export type ViewMode =
	| { kind: "hunks"; context: number } // default: context = 3
	| { kind: "full" }; // every line of the changed file(s)

export type DiffLineKind = "ctx" | "add" | "del" | "pad";

/**
 * One row in the two-way display. A row carries, at most, one old line and
 * one new line (we align +/- runs 1:1 and insert `pad` fillers where needed).
 */
export interface DiffLine {
	kind: DiffLineKind;
	/** 1-based old line number; undefined for `add` / `pad`. */
	oldLineNo?: number;
	/** 1-based new line number; undefined for `del` / `pad`. */
	newLineNo?: number;
	/** The raw line content, without any leading +/- or space marker. */
	text: string;
}

export interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** The raw @@ header, e.g. `@@ -40,4 +40,4 @@ function foo()`. */
	header: string;
	/** Rows after +/- pairing; `del`/`add` runs are padded on the opposite side. */
	lines: DiffLine[];
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "untracked" | "clean";

export interface FileDiff {
	oldPath: string; // "/dev/null" for added/untracked
	newPath: string; // "/dev/null" for deleted
	/** Best path to show (usually `newPath`, falling back to `oldPath`). */
	displayPath: string;
	status: FileStatus;
	hunks: Hunk[];
	binary?: boolean;
	/** Optional note shown instead of hunks (e.g. "File too large (3.2 MB)"). */
	note?: string;
}
