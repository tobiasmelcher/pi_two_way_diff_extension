/**
 * Alignment helpers.
 *
 * Transforms raw unified-diff lines ('+', '-', ' ') into side-by-side rows.
 * For each contiguous run of `-` followed by `+`, pairs them 1:1 so the two
 * panes line up visually. Leftover lines pad the opposite side with `pad`.
 *
 * This is a cheap, left-biased alignment — not a true LCS, but good enough
 * for interactive review. It can be swapped later without touching the UI.
 */

import type { DiffLine } from "./types.ts";

type RawLine = { marker: "+" | "-" | " "; text: string };

/**
 * Align a parsed unified-diff block.
 *
 * @param rawLines  The lines of a single hunk, with their +/-/space markers.
 * @param oldStart  The starting old-side line number (1-based).
 * @param newStart  The starting new-side line number (1-based).
 */
export function alignHunkLines(rawLines: RawLine[], oldStart: number, newStart: number): DiffLine[] {
	const out: DiffLine[] = [];
	let oldNo = oldStart;
	let newNo = newStart;

	let i = 0;
	while (i < rawLines.length) {
		const raw = rawLines[i];
		if (!raw) {
			i++;
			continue;
		}
		if (raw.marker === " ") {
			out.push({ kind: "ctx", oldLineNo: oldNo, newLineNo: newNo, text: raw.text });
			oldNo++;
			newNo++;
			i++;
			continue;
		}

		// Collect a run of consecutive `-` lines, then any following `+` lines.
		const dels: RawLine[] = [];
		while (i < rawLines.length && rawLines[i]?.marker === "-") {
			dels.push(rawLines[i]!);
			i++;
		}
		const adds: RawLine[] = [];
		while (i < rawLines.length && rawLines[i]?.marker === "+") {
			adds.push(rawLines[i]!);
			i++;
		}

		const paired = Math.min(dels.length, adds.length);
		for (let k = 0; k < paired; k++) {
			out.push({ kind: "del", oldLineNo: oldNo, text: dels[k]!.text });
			out.push({ kind: "add", newLineNo: newNo, text: adds[k]!.text });
			oldNo++;
			newNo++;
		}
		// Leftover deletions: left column shows `del`, right side gets a `pad`.
		for (let k = paired; k < dels.length; k++) {
			out.push({ kind: "del", oldLineNo: oldNo, text: dels[k]!.text });
			out.push({ kind: "pad", text: "" });
			oldNo++;
		}
		// Leftover additions: right column shows `add`, left side gets a `pad`.
		for (let k = paired; k < adds.length; k++) {
			out.push({ kind: "pad", text: "" });
			out.push({ kind: "add", newLineNo: newNo, text: adds[k]!.text });
			newNo++;
		}
	}

	return out;
}

/**
 * Pair the flat sequence of DiffLines into aligned (left, right) rows.
 * This is what the side-by-side renderer actually iterates over.
 *
 * Rules:
 *  - A `ctx` row maps to (ctx, ctx) with the same text on both sides.
 *  - A `del` immediately followed by `add` maps to (del, add).
 *  - A lone `del` maps to (del, pad).
 *  - A lone `add` maps to (pad, add).
 *  - A `pad` on its own is swallowed if its partner is on the previous row
 *    (which is how `alignHunkLines` emits them).
 */
export interface AlignedRow {
	left: DiffLine; // may be `pad`
	right: DiffLine; // may be `pad`
}

export function pairIntoRows(lines: DiffLine[]): AlignedRow[] {
	const rows: AlignedRow[] = [];
	let i = 0;
	while (i < lines.length) {
		const cur = lines[i]!;
		if (cur.kind === "ctx") {
			rows.push({ left: cur, right: cur });
			i++;
			continue;
		}
		// `alignHunkLines` already emits paired del/add pairs or pad fillers,
		// so look at the next line to decide.
		const next = lines[i + 1];
		if (cur.kind === "del" && next?.kind === "add") {
			rows.push({ left: cur, right: next });
			i += 2;
			continue;
		}
		if (cur.kind === "del" && next?.kind === "pad") {
			rows.push({ left: cur, right: next });
			i += 2;
			continue;
		}
		if (cur.kind === "pad" && next?.kind === "add") {
			rows.push({ left: cur, right: next });
			i += 2;
			continue;
		}
		// Shouldn't happen, but keep moving.
		rows.push({ left: cur, right: { kind: "pad", text: "" } });
		i++;
	}
	return rows;
}
