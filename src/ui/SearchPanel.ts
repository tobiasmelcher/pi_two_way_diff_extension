/**
 * Search-as-you-type panel for the diff view.
 *
 * Lives inside DiffViewComponent while `mode === "search"`. Shows a one-line
 * query input at the top of the panel and a scrollable list of matching
 * source lines underneath. Enter jumps the diff cursor to the selected
 * match's virtual-row; Esc cancels.
 *
 * Match semantics:
 *  - Smart-case: lowercase query → case-insensitive; any uppercase → case-
 *    sensitive. (Matches vim / ripgrep conventions.)
 *  - Simple substring (no regex). Live-updates on every keystroke.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type Focusable,
	matchesKey,
	renderFakeCursor,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** One searchable row in the current file. */
export interface SearchItem {
	/** Virtual-row index inside the DiffViewComponent's rows. */
	rowIndex: number;
	/** The text to search inside. */
	text: string;
	/** Display line number (new side preferred). */
	lineNo: number | undefined;
	/** Side indicator: `+` added, `-` removed, ` ` context. */
	side: "+" | "-" | " ";
}

/** A found match, with the exact substring range for highlighting. */
export interface SearchMatch extends SearchItem {
	matchStart: number;
	matchLength: number;
}

export interface SearchPanelOptions {
	/** Text shown in the bottom border. */
	hint?: string;
	/** Called whenever the query changes (used by asynchronous search sources). */
	onQueryChange?: (query: string) => void;
}

export class SearchPanel implements Focusable {
	focused = true;

	private items: SearchItem[];
	private readonly onJump: (rowIndex: number) => void;
	private readonly onCancel: () => void;
	private readonly hint: string;
	private readonly onQueryChange: ((query: string) => void) | undefined;

	private query = "";
	private cursor = 0;
	private matches: SearchMatch[] = [];
	private selected = 0;
	private scrollTop = 0;

	/** Fixed on-screen height of the panel: 1 input + N match rows + 1 hint. */
	readonly maxMatchRows: number;

	constructor(
		items: SearchItem[],
		onJump: (rowIndex: number) => void,
		onCancel: () => void,
		maxMatchRows = 8,
		options: SearchPanelOptions = {},
	) {
		this.items = items;
		this.onJump = onJump;
		this.onCancel = onCancel;
		this.maxMatchRows = maxMatchRows;
		this.hint = options.hint ?? "Enter jump · ↑↓ navigate · Esc cancel";
		this.onQueryChange = options.onQueryChange;
	}

	/** Total height the panel will take on screen. */
	get height(): number {
		return 1 /*input*/ + this.visibleMatchRows() + 1 /*hint*/;
	}

	/** Current cursor-highlight target in the diff body (for live preview). */
	get activeRowIndex(): number | undefined {
		return this.matches[this.selected]?.rowIndex;
	}

	get matchCount(): number {
		return this.matches.length;
	}

	get selectedIndex(): number {
		return this.selected;
	}

	get queryText(): string {
		return this.query;
	}

	/** Replace asynchronous search results while preserving the current query. */
	setItems(items: SearchItem[]): void {
		this.items = items;
		this.recompute(false);
	}

	/** Set a query programmatically, notifying asynchronous result providers. */
	setQuery(query: string, notify = true): void {
		this.query = query;
		this.cursor = query.length;
		this.recompute(notify);
	}

	/** Select a match by its underlying row index when restored asynchronously. */
	selectRowIndex(rowIndex: number): void {
		const index = this.matches.findIndex((match) => match.rowIndex === rowIndex);
		if (index >= 0) this.moveSelected(index - this.selected);
	}

	/** Returns true if the key was handled by the panel. */
	handleInput(data: string): boolean {
		if (matchesKey(data, "escape")) {
			this.onCancel();
			return true;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const m = this.matches[this.selected];
			if (m) this.onJump(m.rowIndex);
			else this.onCancel();
			return true;
		}
		if (matchesKey(data, "down")) {
			this.moveSelected(1);
			return true;
		}
		if (matchesKey(data, "up")) {
			this.moveSelected(-1);
			return true;
		}
		if (matchesKey(data, "pageDown")) {
			this.moveSelected(this.maxMatchRows);
			return true;
		}
		if (matchesKey(data, "pageUp")) {
			this.moveSelected(-this.maxMatchRows);
			return true;
		}
		if (matchesKey(data, "backspace")) {
			if (this.cursor > 0) {
				this.query = this.query.slice(0, this.cursor - 1) + this.query.slice(this.cursor);
				this.cursor--;
				this.recompute();
			}
			return true;
		}
		if (matchesKey(data, "left")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return true;
		}
		if (matchesKey(data, "right")) {
			this.cursor = Math.min(this.query.length, this.cursor + 1);
			return true;
		}
		if (matchesKey(data, "home")) {
			this.cursor = 0;
			return true;
		}
		if (matchesKey(data, "end")) {
			this.cursor = this.query.length;
			return true;
		}
		// Insert printable chars.
		if (data.length === 1) {
			const code = data.charCodeAt(0);
			if (code >= 32 && code !== 127) {
				this.query = this.query.slice(0, this.cursor) + data + this.query.slice(this.cursor);
				this.cursor++;
				this.recompute();
				return true;
			}
			return false;
		}
		// Multi-byte paste (not a control sequence).
		if (!data.startsWith("\x1b")) {
			this.query = this.query.slice(0, this.cursor) + data + this.query.slice(this.cursor);
			this.cursor += data.length;
			this.recompute();
			return true;
		}
		return false;
	}

	render(theme: Theme, width: number): string[] {
		const lines: string[] = [];
		const t = theme;
		const inner = Math.max(1, width - 2);

		// Top border + input
		lines.push(t.fg("border", `\u250c${"\u2500".repeat(inner)}\u2510`));
		const input = this.renderInputLine(t, inner);
		lines.push(t.fg("border", "\u2502") + input + t.fg("border", "\u2502"));

		// Separator
		lines.push(t.fg("border", `\u251c${"\u2500".repeat(inner)}\u2524`));

		// Match list
		const rows = this.visibleMatchRows();
		if (this.matches.length === 0) {
			const msg = this.query.length === 0 ? "Type to search\u2026" : "No matches";
			const l = padInside(t.fg("dim", `  ${msg}`), inner);
			lines.push(t.fg("border", "\u2502") + l + t.fg("border", "\u2502"));
			for (let i = 1; i < rows; i++) {
				lines.push(t.fg("border", "\u2502") + " ".repeat(inner) + t.fg("border", "\u2502"));
			}
		} else {
			const start = this.scrollTop;
			const end = Math.min(this.matches.length, start + rows);
			for (let i = start; i < end; i++) {
				const m = this.matches[i]!;
				const isSel = i === this.selected;
				const row = this.renderMatchRow(t, m, inner, isSel);
				lines.push(t.fg("border", "\u2502") + row + t.fg("border", "\u2502"));
			}
			for (let i = end - start; i < rows; i++) {
				lines.push(t.fg("border", "\u2502") + " ".repeat(inner) + t.fg("border", "\u2502"));
			}
		}

		// Bottom border with hint
		const hint = ` ${this.hint} `;
		const bottomLine = this.renderBottomWithHint(t, inner, hint);
		lines.push(bottomLine);

		return lines;
	}

	// --------------------------------------------------- private
	private recompute(notify = true): void {
		if (notify) this.onQueryChange?.(this.query);
		const q = this.query;
		if (q.length === 0) {
			this.matches = [];
			this.selected = 0;
			this.scrollTop = 0;
			return;
		}
		const caseSensitive = /[A-Z]/.test(q);
		const needle = caseSensitive ? q : q.toLowerCase();
		const out: SearchMatch[] = [];
		for (const it of this.items) {
			const hay = caseSensitive ? it.text : it.text.toLowerCase();
			const match = findAsteriskMatch(hay, needle);
			if (match) {
				out.push({ ...it, matchStart: match.start, matchLength: match.length });
			}
		}
		this.matches = out;
		this.selected = 0;
		this.scrollTop = 0;
	}

	private moveSelected(delta: number): void {
		if (this.matches.length === 0) return;
		this.selected = clamp(this.selected + delta, 0, this.matches.length - 1);
		// Keep selected within scrollTop..scrollTop+maxMatchRows
		const rows = this.visibleMatchRows();
		if (this.selected < this.scrollTop) this.scrollTop = this.selected;
		if (this.selected >= this.scrollTop + rows) this.scrollTop = this.selected - rows + 1;
		this.scrollTop = Math.max(0, this.scrollTop);
	}

	private visibleMatchRows(): number {
		return Math.max(1, Math.min(this.maxMatchRows, Math.max(this.matches.length, 1)));
	}

	private renderInputLine(t: Theme, inner: number): string {
		const prefix = t.fg("accent", "/ ");
		const prefixW = visibleWidth(prefix);
		const counter = this.matches.length > 0 ? ` ${this.selected + 1}/${this.matches.length}` : "";
		const counterStyled = t.fg("dim", counter);
		const counterW = visibleWidth(counterStyled);

		const bodyW = Math.max(1, inner - prefixW - counterW);
		const before = this.query.slice(0, this.cursor);
		const after = this.query.slice(this.cursor);
		const cursorChar = after[0] ?? " ";
		const afterTail = after.slice(1);
		const marker = this.focused ? CURSOR_MARKER : "";
		const body = `${before}${marker}${renderFakeCursor(cursorChar)}${afterTail}`;
		const trunc = truncateToWidth(body, bodyW);
		const padded = padInside(trunc, bodyW);
		return `${prefix}${padded}${counterStyled}`;
	}

	private renderMatchRow(t: Theme, m: SearchMatch, inner: number, isSelected: boolean): string {
		const marker = isSelected ? t.fg("accent", "\u25b6 ") : "  ";
		const lineNoStr = pad(String(m.lineNo ?? ""), 5);
		const sideCol =
			m.side === "+"
				? t.fg("toolDiffAdded", "+ ")
				: m.side === "-"
					? t.fg("toolDiffRemoved", "- ")
					: t.fg("dim", "  ");
		const header = `${marker}${t.fg("dim", lineNoStr)} ${sideCol}`;
		const headerW = visibleWidth(header);
		const bodyW = Math.max(1, inner - headerW);
		const highlighted = highlightMatch(t, m.text, m.matchStart, m.matchLength, bodyW);
		const row = `${header}${highlighted}`;
		const padded = padInside(row, inner);
		return isSelected ? t.style(padded, { inverse: true, bold: true }) : padded;
	}

	private renderBottomWithHint(t: Theme, inner: number, hint: string): string {
		const hintW = visibleWidth(hint);
		if (hintW + 4 >= inner) {
			return t.fg("border", `\u2514${"\u2500".repeat(inner)}\u2518`);
		}
		// Place the hint flush-right in the border.
		const left = "\u2500".repeat(inner - hintW - 2);
		return (
			t.fg("border", "\u2514") +
			t.fg("border", left) +
			" " +
			t.fg("dim", hint.trim()) +
			" " +
			t.fg("border", "\u2518")
		);
	}

	dispose(): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(s: string, len: number): string {
	const v = visibleWidth(s);
	if (v >= len) return s;
	return s + " ".repeat(len - v);
}

function padInside(s: string, len: number): string {
	const v = visibleWidth(s);
	if (v >= len) return truncateToWidth(s, len);
	return s + " ".repeat(len - v);
}

/**
 * Match a search query against text, where `*` is the sole pattern operator
 * and means any string (including an empty one). Queries remain unanchored,
 * preserving normal search's substring behavior: `foo*bar` can occur
 * anywhere in a path or source line. No other regex or glob syntax exists.
 */
function findAsteriskMatch(text: string, query: string): { start: number; length: number } | undefined {
	if (!query.includes("*")) {
		const start = text.indexOf(query);
		return start >= 0 ? { start, length: query.length } : undefined;
	}

	const parts = query.split("*").filter((part) => part.length > 0);
	if (parts.length === 0) return { start: 0, length: 0 }; // `*` matches everything.

	let cursor = 0;
	let start = -1;
	let end = -1;
	for (const part of parts) {
		const index = text.indexOf(part, cursor);
		if (index < 0) return undefined;
		if (start < 0) start = index;
		end = index + part.length;
		cursor = end;
	}
	return { start, length: end - start };
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

/**
 * Highlight the matched substring of a source line, keeping the full match
 * visible by sliding the viewport if the match would be off-screen.
 */
function highlightMatch(
	t: Theme,
	text: string,
	matchStart: number,
	matchLength: number,
	bodyW: number,
): string {
	if (bodyW <= 0) return "";
	// Slide so the match is visible. Try to keep ~1/4 of a pane of context
	// before the match where possible.
	const context = Math.max(0, Math.floor(bodyW / 4));
	let viewStart = Math.max(0, matchStart - context);
	// If the match extends beyond the visible area starting at viewStart,
	// slide further right.
	if (matchStart + matchLength > viewStart + bodyW) {
		viewStart = Math.max(0, matchStart + matchLength - bodyW);
	}
	const visible = text.slice(viewStart, viewStart + bodyW);
	const relStart = matchStart - viewStart;
	const relEnd = relStart + matchLength;

	if (relStart < 0 || relEnd > visible.length) {
		// Shouldn't happen given the sliding above; fall back to no highlight.
		return truncateToWidth(visible, bodyW);
	}
	const before = visible.slice(0, relStart);
	const hit = visible.slice(relStart, relEnd);
	const after = visible.slice(relEnd);
	const styledHit = t.style(hit, { inverse: true, bold: true });
	const prefix = viewStart > 0 ? t.fg("dim", "\u2026") : "";
	const suffix = text.length > viewStart + bodyW ? t.fg("dim", "\u2026") : "";
	const line = `${prefix}${before}${styledHit}${after}${suffix}`;
	return truncateToWidth(line, bodyW);
}
