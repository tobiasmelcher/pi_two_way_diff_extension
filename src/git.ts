/**
 * Git source: discovers open changes and parses unified diff into FileDiff[].
 *
 * Uses Git's index for file picking rather than recursively walking the
 * filesystem, which avoids scanning large ignored dependency/build trees.
 *   1. `git rev-parse --show-toplevel`              (verify we are in a repo)
 *   2. `git diff --no-color --unified=<N> HEAD`     (tracked vs. HEAD)
 *      (falls back to `git diff --cached` + `git diff` on an empty repo)
 *   3. `git ls-files --others --exclude-standard`   (untracked files)
 *
 * We request the parsed `FileDiff[]` with a target context size `N`. When the
 * caller wants the full file, pass something huge (e.g. 1_000_000) and git
 * will emit every line of each changed file.
 */

import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { alignHunkLines } from "./align.ts";
import type { DiffLine, FileDiff, FileStatus, Hunk } from "./types.ts";

const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

export interface GitDiffOptions {
	cwd: string;
	/** Context lines around hunks. Use a very large number for "full file". */
	context: number;
	/** Include untracked files (can be deferred because Git's ignore scan is costly). */
	includeUntracked?: boolean;
}

/**
 * Stream matching tracked-file lines from Git. The query has only one pattern
 * operator: `*` means any text; every other character is escaped literally.
 * Returns a cancellation function for superseded search-as-you-type queries.
 */
export function searchGitText(
	cwd: string,
	query: string,
	onMatch: (match: { path: string; lineNo: number; text: string }) => void,
	onDone: () => void,
): () => void {
	const pattern = query.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	const args = ["grep", "-z", "-n", "-I", "--no-color", "-E"];
	if (!/[A-Z]/.test(query)) args.push("-i");
	args.push("-e", pattern);
	const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
	let pending = "";
	let pathField: string | undefined;
	let lineField: string | undefined;
	const consume = () => {
		while (true) {
			if (pathField === undefined) {
				const nul = pending.indexOf("\0");
				if (nul < 0) return;
				pathField = pending.slice(0, nul);
				pending = pending.slice(nul + 1);
			}
			if (lineField === undefined) {
				const nul = pending.indexOf("\0");
				if (nul < 0) return;
				lineField = pending.slice(0, nul);
				pending = pending.slice(nul + 1);
			}
			const newline = pending.indexOf("\n");
			if (newline < 0) return;
			onMatch({ path: pathField, lineNo: Number(lineField), text: pending.slice(0, newline) });
			pending = pending.slice(newline + 1);
			pathField = undefined;
			lineField = undefined;
		}
	};
	child.stdout.on("data", (chunk: Buffer) => {
		pending += chunk.toString("utf8");
		consume();
	});
	child.once("close", onDone);
	child.once("error", onDone);
	return () => { if (!child.killed) child.kill(); };
}

export class NotAGitRepoError extends Error {
	constructor(cwd: string) {
		super(`${cwd} is not inside a git working tree`);
		this.name = "NotAGitRepoError";
	}
}

export async function collectGitDiffs(opts: GitDiffOptions): Promise<FileDiff[]> {
	const { cwd, context } = opts;

	// 1. Verify repo. Also gives us the repo root for untracked reads.
	let repoRoot: string;
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
		repoRoot = stdout.trim();
	} catch {
		throw new NotAGitRepoError(cwd);
	}

	// 2. Tracked changes. Try vs HEAD first; on an empty repo (no HEAD) fall
	//    back to cached + working tree.
	let unified = "";
	let hasHead = true;
	try {
		await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd });
	} catch {
		hasHead = false;
	}

	if (hasHead) {
		const { stdout } = await execFileAsync(
			"git",
			["diff", "--no-color", "--no-ext-diff", `--unified=${context}`, "HEAD"],
			// bump buffer so huge diffs don't EBADF
			{ cwd, maxBuffer: 64 * 1024 * 1024 },
		);
		unified = stdout;
	} else {
		const { stdout: a } = await execFileAsync(
			"git",
			["diff", "--no-color", "--no-ext-diff", `--unified=${context}`, "--cached"],
			{ cwd, maxBuffer: 64 * 1024 * 1024 },
		);
		const { stdout: b } = await execFileAsync(
			"git",
			["diff", "--no-color", "--no-ext-diff", `--unified=${context}`],
			{ cwd, maxBuffer: 64 * 1024 * 1024 },
		);
		unified = a + b;
	}

	const tracked = parseUnifiedDiff(unified);
	if (opts.includeUntracked === false) return tracked;

	// 3. Untracked files: synthesize an "all added" FileDiff per file.
	const { stdout: untrackedList } = await execFileAsync(
		"git",
		["ls-files", "--others", "--exclude-standard"],
		{ cwd, maxBuffer: 16 * 1024 * 1024 },
	);
	const untrackedPaths = untrackedList.split("\n").filter((p) => p.length > 0);
	const untracked = (await mapLimit(untrackedPaths, 8, async (relPath) => {
		const diff = await buildUntrackedFileDiff(path.join(repoRoot, relPath), relPath);
		return diff;
	})).filter((diff): diff is FileDiff => diff !== null);

	// Sort: modified before added before deleted, path alphabetical inside.
	const all = [...tracked, ...untracked];
	all.sort((a, b) => {
		const r = statusRank(a.status) - statusRank(b.status);
		if (r !== 0) return r;
		return a.displayPath.localeCompare(b.displayPath);
	});
	return all;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			out[index] = await fn(items[index]!);
		}
	}));
	return out;
}

function statusRank(s: FileStatus): number {
	switch (s) {
		case "modified":
			return 0;
		case "renamed":
			return 1;
		case "added":
			return 2;
		case "untracked":
			return 3;
		case "deleted":
			return 4;
		case "clean":
			return 5;
	}
}

/**
 * List files that Git considers part of the working tree: tracked files plus
 * non-ignored untracked files. This is intentionally index-backed rather than
 * a recursive `readdir`: large repositories commonly have ignored build or
 * dependency directories, and walking them made opening `/diff` slow.
 */
export async function listWorkingTreeFiles(cwd: string): Promise<string[]> {
	const { stdout } = await execFileAsync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd, maxBuffer: 64 * 1024 * 1024 },
	);
	return [...new Set(stdout.split("\0").filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Build a full-file, no-change view for an arbitrary working-tree file. */
export async function loadWorkingTreeFile(cwd: string, relPath: string): Promise<FileDiff | undefined> {
	const normalized = path.normalize(relPath);
	if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) return undefined;
	const abs = path.join(cwd, normalized);
	let stat;
	try {
		stat = await fs.stat(abs);
	} catch {
		return undefined;
	}
	if (!stat.isFile()) return undefined;
	if (stat.size > MAX_FILE_SIZE) {
		return {
			oldPath: normalized,
			newPath: normalized,
			displayPath: normalized,
			status: "clean",
			hunks: [],
			note: `File too large to show (${formatBytes(stat.size)})`,
		};
	}
	const buf = await fs.readFile(abs);
	if (isLikelyBinary(buf)) {
		return { oldPath: normalized, newPath: normalized, displayPath: normalized, status: "clean", hunks: [], binary: true, note: "Binary file (not shown)" };
	}
	const sourceLines = buf.toString("utf8").split("\n");
	if (sourceLines.at(-1) === "") sourceLines.pop();
	const lines: DiffLine[] = sourceLines.map((text, i) => ({ kind: "ctx", oldLineNo: i + 1, newLineNo: i + 1, text }));
	return {
		oldPath: normalized,
		newPath: normalized,
		displayPath: normalized,
		status: "clean",
		hunks: [{ oldStart: 1, oldLines: lines.length, newStart: 1, newLines: lines.length, header: `@@ -1,${lines.length} +1,${lines.length} @@`, lines }],
	};
}

async function buildUntrackedFileDiff(abs: string, relPath: string): Promise<FileDiff | null> {
	let stat;
	try {
		stat = await fs.stat(abs);
	} catch {
		return null;
	}
	// Skip directories (shouldn't happen with ls-files --others, but defensive).
	if (!stat.isFile()) return null;

	if (stat.size > MAX_FILE_SIZE) {
		return {
			oldPath: "/dev/null",
			newPath: relPath,
			displayPath: relPath,
			status: "untracked",
			hunks: [],
			note: `Untracked file too large to show (${formatBytes(stat.size)})`,
		};
	}

	const buf = await fs.readFile(abs);
	if (isLikelyBinary(buf)) {
		return {
			oldPath: "/dev/null",
			newPath: relPath,
			displayPath: relPath,
			status: "untracked",
			hunks: [],
			binary: true,
			note: "Untracked binary file",
		};
	}

	const text = buf.toString("utf8");
	const srcLines = text.split("\n");
	// Avoid a phantom last empty line when the file ends with a newline.
	if (srcLines.length > 0 && srcLines[srcLines.length - 1] === "") srcLines.pop();

	const lines: DiffLine[] = srcLines.map((t, idx) => ({
		kind: "add" as const,
		newLineNo: idx + 1,
		text: t,
	}));

	// Represent as a single hunk covering the whole file.
	const hunk: Hunk = {
		oldStart: 0,
		oldLines: 0,
		newStart: 1,
		newLines: srcLines.length,
		header: `@@ -0,0 +1,${srcLines.length} @@`,
		lines: alignFlatAdds(lines),
	};

	return {
		oldPath: "/dev/null",
		newPath: relPath,
		displayPath: relPath,
		status: "untracked",
		hunks: [hunk],
	};
}

function alignFlatAdds(lines: DiffLine[]): DiffLine[] {
	// All adds — the left column is all pads. Interleave so pairIntoRows()
	// still produces (pad, add) rows.
	const out: DiffLine[] = [];
	for (const l of lines) {
		out.push({ kind: "pad", text: "" });
		out.push(l);
	}
	return out;
}

function isLikelyBinary(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8000);
	for (let i = 0; i < n; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Unified diff parser
// ---------------------------------------------------------------------------

/**
 * Parse the output of `git diff --no-color` into FileDiff[].
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
	if (!text) return [];
	const lines = text.split("\n");
	const files: FileDiff[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (!line.startsWith("diff --git ")) {
			i++;
			continue;
		}
		// Start of a new file section.
		const [, aPath, bPath] = parseDiffGitHeader(line);
		let oldPath = aPath;
		let newPath = bPath;
		let status: FileStatus = "modified";
		let binary = false;
		let note: string | undefined;

		i++;

		// Walk the extended header lines until we hit `@@` or the next
		// `diff --git`.
		while (i < lines.length) {
			const h = lines[i] ?? "";
			if (h.startsWith("diff --git ")) break;
			if (h.startsWith("@@")) break;

			if (h.startsWith("new file mode")) status = "added";
			else if (h.startsWith("deleted file mode")) status = "deleted";
			else if (h.startsWith("rename from ") || h.startsWith("rename to ")) status = "renamed";
			else if (h.startsWith("--- ")) {
				const p = h.slice(4).trim();
				oldPath = p === "/dev/null" ? "/dev/null" : stripPrefix(p);
			} else if (h.startsWith("+++ ")) {
				const p = h.slice(4).trim();
				newPath = p === "/dev/null" ? "/dev/null" : stripPrefix(p);
			} else if (h.startsWith("Binary files ")) {
				binary = true;
				note = h.trim();
			}
			i++;
		}

		const hunks: Hunk[] = [];
		while (i < lines.length) {
			const h = lines[i] ?? "";
			if (h.startsWith("diff --git ")) break;
			if (!h.startsWith("@@")) {
				i++;
				continue;
			}
			const parsedHeader = parseHunkHeader(h);
			if (!parsedHeader) {
				i++;
				continue;
			}
			i++;

			const raw: { marker: "+" | "-" | " "; text: string }[] = [];
			while (i < lines.length) {
				const l = lines[i] ?? "";
				if (l.startsWith("diff --git ") || l.startsWith("@@")) break;
				if (l.startsWith("\\")) {
					// "\ No newline at end of file" — ignore for display.
					i++;
					continue;
				}
				if (l.length === 0) {
					// Trailing empty string from `split("\n")`, not a real line.
					// Genuine empty context lines come through as a single space.
					i++;
					continue;
				}
				const marker = l[0];
				const text = l.slice(1);
				if (marker === "+" || marker === "-" || marker === " ") {
					raw.push({ marker, text });
				}
				i++;
			}

			const aligned = alignHunkLines(raw, parsedHeader.oldStart, parsedHeader.newStart);
			hunks.push({
				oldStart: parsedHeader.oldStart,
				oldLines: parsedHeader.oldLines,
				newStart: parsedHeader.newStart,
				newLines: parsedHeader.newLines,
				header: parsedHeader.header,
				lines: aligned,
			});
		}

		const displayPath = newPath !== "/dev/null" ? newPath : oldPath;
		files.push({ oldPath, newPath, displayPath, status, hunks, binary, note });
	}
	return files;
}

function parseDiffGitHeader(line: string): [string, string, string] {
	// `diff --git a/foo b/foo`
	const rest = line.slice("diff --git ".length).trim();
	// Simple split: find ' b/' as the boundary (works for standard git output).
	const idx = rest.indexOf(" b/");
	if (idx === -1) return [line, "", ""];
	const a = rest.slice(0, idx);
	const b = rest.slice(idx + 1);
	return [line, stripPrefix(a), stripPrefix(b)];
}

function stripPrefix(p: string): string {
	if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
	return p;
}

/**
 * Parse `@@ -oldStart,oldLines +newStart,newLines @@ optional-context`.
 * The ",count" parts are optional (default = 1).
 */
function parseHunkHeader(
	line: string,
): { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string } | null {
	const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
	if (!m) return null;
	const oldStart = parseInt(m[1] ?? "0", 10);
	const oldLines = m[2] !== undefined ? parseInt(m[2], 10) : 1;
	const newStart = parseInt(m[3] ?? "0", 10);
	const newLines = m[4] !== undefined ? parseInt(m[4], 10) : 1;
	return { oldStart, oldLines, newStart, newLines, header: line };
}
