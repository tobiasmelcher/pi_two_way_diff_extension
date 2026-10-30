/**
 * Rendering: turn a `FileDiff` (and the current viewport state) into an
 * array of ANSI-styled lines, each already fitting the available width.
 *
 * Pure, cache-friendly: given the same inputs, returns the same lines.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { type AlignedRow, pairIntoRows } from "./align.ts";
import type { DiffLine, FileDiff } from "./types.ts";

/** A "virtual row" index inside a file (header + hunk header + diff rows). */
export interface VirtualRow {
	kind: "fileHeader" | "hunkHeader" | "diff" | "note" | "spacer";
	hunkIndex?: number;
	rowIndex?: number;
	fileHeader?: FileDiff;
	hunkHeader?: string;
	note?: string;
	alignedRow?: AlignedRow;
}

/** Build the virtual row list for a single file. */
export function buildVirtualRows(file: FileDiff): VirtualRow[] {
	const rows: VirtualRow[] = [];
	rows.push({ kind: "fileHeader", fileHeader: file });

	if (file.note) {
		rows.push({ kind: "note", note: file.note });
		return rows;
	}
	if (file.binary) {
		rows.push({ kind: "note", note: "Binary file (not shown)" });
		return rows;
	}
	if (file.hunks.length === 0) {
		rows.push({ kind: "note", note: "No changes" });
		return rows;
	}

	for (let hi = 0; hi < file.hunks.length; hi++) {
		const hunk = file.hunks[hi]!;
		if (hi > 0) rows.push({ kind: "spacer" });
		rows.push({ kind: "hunkHeader", hunkIndex: hi, hunkHeader: hunk.header });
		const paired = pairIntoRows(hunk.lines);
		for (let ri = 0; ri < paired.length; ri++) {
			rows.push({ kind: "diff", hunkIndex: hi, rowIndex: ri, alignedRow: paired[ri] });
		}
	}
	return rows;
}

/** Side-by-side vs. unified layout threshold. */
const SIDE_BY_SIDE_MIN_WIDTH = 100;
export function shouldUseSideBySide(width: number): boolean {
	return width >= SIDE_BY_SIDE_MIN_WIDTH;
}

/**
 * Width of the left-edge indicator column shown in front of every row.
 * This marker is color-blind safe (a visible glyph, not just a background).
 */
const MARKER_W = 2;

/** Produce the 2-column marker prefix for a row given its state. */
function markerFor(o: RowRenderOpts): string {
	if (o.isCursor && o.isSelected) return o.theme.fg("accent", "▶█");
	if (o.isCursor) return o.theme.fg("accent", "▶ ");
	if (o.isSelected) return o.theme.fg("warning", "█ ");
	return "  ";
}

export interface RenderOptions {
	theme: Theme;
	width: number;
	bodyHeight: number;
	rows: VirtualRow[];
	scrollTop: number;
	cursorRow: number; // -1 = none
	selection?: { fromRow: number; toRow: number };
	sideBySide: boolean;
	/** When true in side-by-side mode, render only the new/source (right) pane. */
	hideLeft?: boolean;
	/** Syntax highlighting language for source text, when supported. */
	language?: "java";
	/** Horizontal scroll offset in columns (applies to diff bodies only). */
	scrollX?: number;
}

/** Always returns exactly `bodyHeight` lines fitting `width`. */
export function renderDiffViewport(opts: RenderOptions): string[] {
	const { theme, width, bodyHeight, rows, scrollTop, cursorRow, selection, sideBySide } = opts;
	const hideLeft = opts.hideLeft === true;
	const language = opts.language;
	const scrollX = Math.max(0, opts.scrollX ?? 0);
	const out: string[] = [];
	const end = Math.min(rows.length, scrollTop + bodyHeight);
	const selLo = selection != null ? Math.min(selection.fromRow, selection.toRow) : -1;
	const selHi = selection != null ? Math.max(selection.fromRow, selection.toRow) : -1;
	for (let i = scrollTop; i < end; i++) {
		const row = rows[i]!;
		const isCursor = i === cursorRow;
		const isSelected = selection != null && i >= selLo && i <= selHi;
		out.push(renderOneRow(row, { theme, width, isCursor, isSelected, sideBySide, hideLeft, language, scrollX }));
	}
	while (out.length < bodyHeight) out.push(padLine(theme.fg("dim", "~"), width));
	return out;
}

interface RowRenderOpts {
	theme: Theme;
	width: number;
	isCursor: boolean;
	isSelected: boolean;
	sideBySide: boolean;
	hideLeft: boolean;
	language?: "java";
	/** Horizontal scroll offset (columns) applied to diff body cells only. */
	scrollX: number;
}

function renderOneRow(row: VirtualRow, o: RowRenderOpts): string {
	switch (row.kind) {
		case "fileHeader":
			return renderFileHeader(row.fileHeader!, o);
		case "hunkHeader":
			return renderHunkHeader(row.hunkHeader ?? "", o);
		case "note":
			return padLine(o.theme.fg("dim", `${markerFor(o)}${row.note ?? ""}`), o.width);
		case "spacer":
			return padLine(o.theme.fg("dim", `${markerFor(o)}…`), o.width);
		case "diff":
			return o.sideBySide
				? o.hideLeft
					? renderDiffRowRightOnly(row.alignedRow!, o)
					: renderDiffRowSBS(row.alignedRow!, o)
				: renderDiffRowUnified(row.alignedRow!, o);
	}
}

function renderFileHeader(file: FileDiff, o: RowRenderOpts): string {
	const title = `${o.theme.bold(file.displayPath)}  ${o.theme.fg("dim", `(${file.status})`)}`;
	const titleStyled = `${markerFor(o)}${o.theme.fg("accent", title)}`;
	const titleW = visibleWidth(titleStyled);
	if (titleW + 2 >= o.width) return padLine(truncateToWidth(titleStyled, o.width), o.width);
	const rest = o.width - titleW - 2;
	return padLine(`${titleStyled}  ${o.theme.fg("border", "─".repeat(rest))}`, o.width);
}

function renderHunkHeader(header: string, o: RowRenderOpts): string {
	return padLine(
		o.theme.fg("borderAccent", truncateToWidth(`${markerFor(o)}${header}`, o.width)),
		o.width,
	);
}

// ---------------------------------------------------------------------------
// Side-by-side body
// ---------------------------------------------------------------------------

function renderDiffRowSBS(pair: AlignedRow, o: RowRenderOpts): string {
	const divider = o.theme.fg("border", "│");
	const dividerW = 1;
	const marker = markerFor(o);
	const remainingWidth = o.width - MARKER_W;
	const paneW = Math.max(10, Math.floor((remainingWidth - dividerW) / 2));

	const left = renderCell(pair.left, paneW, o);
	const right = renderCell(pair.right, remainingWidth - dividerW - paneW, o);

	const combined = padLine(`${marker}${left}${divider}${right}`, o.width);
	return applyRowHighlight(combined, o);
}

function renderDiffRowRightOnly(pair: AlignedRow, o: RowRenderOpts): string {
	const marker = markerFor(o);
	const paneW = Math.max(0, o.width - MARKER_W);
	const line = renderCell(pair.right, paneW, o);
	return applyRowHighlight(padLine(`${marker}${line}`, o.width), o);
}

function renderCell(dl: DiffLine, paneW: number, o: RowRenderOpts): string {
	const theme = o.theme;
	if (dl.kind === "pad") return padRight("", paneW); // blank filler
	const sign = dl.kind === "add" ? "+" : dl.kind === "del" ? "-" : " ";
	const num =
		dl.kind === "add"
			? dl.newLineNo
			: dl.kind === "del"
				? dl.oldLineNo
				: (dl.oldLineNo ?? dl.newLineNo);
	const gutter = `${pad(String(num ?? ""), 5)} ${sign} `;
	const bodyW = Math.max(0, paneW - visibleWidth(gutter));
	const text = sliceBody(detab(dl.text), o.scrollX, bodyW);
	// Preserve add/remove contrast over syntax colors: a dim Java comment on a
	// deleted row was nearly invisible. Syntax coloring is therefore limited to
	// unchanged context; changed rows retain their dedicated diff foreground.
	const useSyntax = o.language === "java" && dl.kind === "ctx";
	const body = useSyntax ? highlightJava(text, theme) : text;
	switch (dl.kind) {
		case "add":
			return theme.fg("toolDiffAdded", gutter) + (useSyntax ? padRight(body, bodyW) : theme.fg("toolDiffAdded", padRight(body, bodyW)));
		case "del":
			return theme.fg("toolDiffRemoved", gutter) + (useSyntax ? padRight(body, bodyW) : theme.fg("toolDiffRemoved", padRight(body, bodyW)));
		case "ctx":
			return theme.fg("dim", gutter) + (useSyntax ? padRight(body, bodyW) : theme.fg("toolDiffContext", padRight(body, bodyW)));
	}
	return padRight("", paneW);
}

// ---------------------------------------------------------------------------
// Unified fallback
// ---------------------------------------------------------------------------

function renderDiffRowUnified(pair: AlignedRow, o: RowRenderOpts): string {
	const theme = o.theme;
	const marker = markerFor(o);
	const dl = pair.right.kind !== "pad" ? pair.right : pair.left;
	if (dl.kind === "pad") return padLine(marker, o.width);
	const sign = dl.kind === "add" ? "+" : dl.kind === "del" ? "-" : " ";
	const num = dl.newLineNo ?? dl.oldLineNo ?? "";
	const gutter = `${pad(String(num), 5)} ${sign} `;
	const bodyW = Math.max(0, o.width - MARKER_W - visibleWidth(gutter));
	const text = sliceBody(detab(dl.text), o.scrollX, bodyW);
	const useSyntax = o.language === "java" && dl.kind === "ctx";
	const body = useSyntax ? highlightJava(text, theme) : text;
	let styled: string;
	switch (dl.kind) {
		case "add":
			styled = theme.fg("toolDiffAdded", gutter) + (useSyntax ? body : theme.fg("toolDiffAdded", body));
			break;
		case "del":
			styled = theme.fg("toolDiffRemoved", gutter) + (useSyntax ? body : theme.fg("toolDiffRemoved", body));
			break;
		case "ctx":
			styled = theme.fg("dim", gutter) + (useSyntax ? body : theme.fg("toolDiffContext", body));
			break;
		default:
			styled = gutter + text;
	}
	return applyRowHighlight(padLine(`${marker}${styled}`, o.width), o);
}

/**
 * Lightweight single-line Java highlighter. It deliberately avoids a parser
 * and regex backtracking: each source character is visited at most once, so
 * coloring remains cheap while scrolling large diffs.
 */
const JAVA_KEYWORDS = new Set([
	"abstract", "assert", "break", "case", "catch", "class", "const", "continue", "default", "do", "else", "enum", "extends", "final", "finally", "for", "goto", "if", "implements", "import", "instanceof", "interface", "native", "new", "package", "private", "protected", "public", "return", "sealed", "static", "strictfp", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "volatile", "while", "yield", "record", "permits", "non-sealed",
]);

export function highlightJava(text: string, theme: Theme): string {
	let out = "";
	let plainStart = 0;
	const flushPlain = (end: number) => {
		if (end > plainStart) out += text.slice(plainStart, end);
	};
	for (let i = 0; i < text.length;) {
		const ch = text[i]!;
		if (ch === "/" && text[i + 1] === "/") {
			flushPlain(i);
			out += theme.fg("dim", text.slice(i));
			return out;
		}
		if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			const stop = end < 0 ? text.length : end + 2;
			flushPlain(i);
			out += theme.fg("dim", text.slice(i, stop));
			i = stop;
			plainStart = i;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let end = i + 1;
			while (end < text.length) {
				if (text[end] === "\\") end += 2;
				else if (text[end++] === quote) break;
			}
			flushPlain(i);
			out += theme.fg("success", text.slice(i, Math.min(end, text.length)));
			i = Math.min(end, text.length);
			plainStart = i;
			continue;
		}
		if (ch === "@" && /[A-Za-z_$]/.test(text[i + 1] ?? "")) {
			let end = i + 2;
			while (end < text.length && /[\w$]/.test(text[end]!)) end++;
			flushPlain(i);
			out += theme.fg("warning", text.slice(i, end));
			i = end;
			plainStart = i;
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			let end = i + 1;
			while (end < text.length && /[\w$]/.test(text[end]!)) end++;
			const word = text.slice(i, end);
			if (JAVA_KEYWORDS.has(word) || word === "true" || word === "false" || word === "null") {
				flushPlain(i);
				out += theme.fg(word === "true" || word === "false" || word === "null" ? "warning" : "accent", word);
				plainStart = end;
			}
			i = end;
			continue;
		}
		i++;
	}
	flushPlain(text.length);
	return out;
}

/**
 * Apply the per-row highlight (cursor / selection). Pi-tui's own
 * `truncateToWidth` embeds a full SGR reset (`\x1b[0m`) around the ellipsis
 * it adds when a line overflows. That reset cancels our outer inverse / bold
 * mid-line and leaves the overflow tail unhighlighted. To avoid that, we
 * split on every embedded reset and re-open our attributes after it, so the
 * row-wide style is preserved end-to-end.
 */
function applyRowHighlight(line: string, o: RowRenderOpts): string {
	const RESET = "\x1b[0m";
	const INV_ON = "\x1b[7m";
	const INV_OFF = "\x1b[27m";
	const BOLD_ON = "\x1b[1m";
	const BOLD_OFF = "\x1b[22m";
	const UND_ON = "\x1b[4m";
	const UND_OFF = "\x1b[24m";

	let opens = "";
	let closes = "";
	if (o.isCursor) {
		opens = INV_ON + BOLD_ON;
		closes = BOLD_OFF + INV_OFF;
	} else if (o.isSelected) {
		opens = UND_ON + BOLD_ON;
		closes = BOLD_OFF + UND_OFF;
	} else {
		return line;
	}

	if (!line.includes(RESET)) {
		return `${opens}${line}${closes}`;
	}
	// Re-apply our opens after every embedded reset.
	const parts = line.split(RESET);
	const rebuilt = parts.join(`${RESET}${opens}`);
	return `${opens}${rebuilt}${closes}`;
}

function detab(s: string): string {
	return s.replace(/\t/g, "    ");
}

/**
 * Slice a plain-text body to the horizontal viewport. The `scrollX` offset
 * only applies within diff body cells; the gutter (line number + sign) is
 * always anchored on the left so you don't lose the line numbers.
 */
function sliceBody(text: string, scrollX: number, width: number): string {
	if (width <= 0) return "";
	if (scrollX <= 0) {
		return truncateToWidth(text, width);
	}
	const sliced = sliceByColumn(text, scrollX, width);
	return sliced;
}

function pad(s: string, len: number): string {
	const v = visibleWidth(s);
	if (v >= len) return sliceByColumn(s, 0, len) ?? s;
	return s + " ".repeat(len - v);
}

function padRight(s: string, len: number): string {
	const v = visibleWidth(s);
	if (v >= len) return s;
	return s + " ".repeat(len - v);
}

function padLine(line: string, width: number): string {
	const v = visibleWidth(line);
	if (v >= width) return truncateToWidth(line, width);
	return line + " ".repeat(width - v);
}
