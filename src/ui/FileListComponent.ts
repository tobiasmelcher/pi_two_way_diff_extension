/**
 * File list component: the entry point of `/diff`.
 *
 * Shows one line per changed file with its status and a change-count summary,
 * and lets the user pick a file to open the two-way diff view for it.
 *
 * This stays colour-blind safe:
 *  - The selected row is marked with a visible left-edge glyph (`▶ `) and
 *    inverse video; both work independently of hue.
 *  - Status badges use short, high-contrast letters (`+`, `-`, `M`, `R`, `?`)
 *    in addition to color.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	matchesKey,
	truncateToWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";

import type { DiffSource, FileDiff, ViewMode } from "../types.ts";
import { SearchPanel } from "./SearchPanel.ts";

export interface TextSearchResult {
	path: string;
	lineNo: number;
	text: string;
}

export type FileListAction =
	| { kind: "open-path"; path: string; lineNo?: number; resumeTextQuery?: string; resumeTextPath?: string; resumeTextLineNo?: number; resumeTextResults?: TextSearchResult[] }
	| { kind: "find-files" }
	| { kind: "quit" }
	| { kind: "refresh" }
	| { kind: "toggle-full" }
	| { kind: "toggle-source" }
	| { kind: "context-change"; delta: 1 | -1 };

export interface FileListOptions {
	files: FileDiff[];
	source: DiffSource;
	viewMode: ViewMode;
	tui: TUI;
	theme: Theme;
	done: (result: FileListAction) => void;
	/** All regular files below the current working directory, for `/` search. */
	allFiles?: string[];
	/** Open the file search immediately (after its paths have been loaded). */
	initialSearch?: boolean;
	/** Load untracked diffs after the list is visible; may be omitted. */
	onLoadUntracked?: () => Promise<FileDiff[]>;
	/** Start an incremental full-text search; returns a cancellation function. */
	onSearchText?: (query: string, onMatch: (match: { path: string; lineNo: number; text: string }) => void, onDone: () => void) => () => void;
	/** Reopen incremental text search after returning from a matched file. */
	initialTextQuery?: string;
	initialTextPath?: string;
	initialTextLineNo?: number;
	/** Cached streamed results restored on back-navigation without re-running Git. */
	initialTextResults?: TextSearchResult[];
	/** Initial cursor row (so returning from the diff view preserves position). */
	initialIndex?: number;
}

export class FileListComponent implements Component, Focusable {
	focused = true;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (r: FileListAction) => void;
	private files: FileDiff[];
	private source: DiffSource;
	private viewMode: ViewMode;
	private cursor: number;
	private scrollTop = 0;
	private readonly allFiles: string[];
	private readonly onSearchText: FileListOptions["onSearchText"];
	private search: SearchPanel | null = null;
	private loadingUntracked = false;
	private cancelTextSearch: (() => void) | null = null;
	private textSearchBusy = false;
	private textSearchTimer: ReturnType<typeof setTimeout> | null = null;
	private textResultTimer: ReturnType<typeof setTimeout> | null = null;
	private textSearchGeneration = 0;
	private textSearchTruncated = false;

	private cachedWidth = -1;
	private cachedHeight = -1;
	private cachedKey = "";
	private cachedLines: string[] = [];
	private themeEpoch = 0;

	constructor(opts: FileListOptions) {
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.done = opts.done;
		this.files = opts.files;
		this.source = opts.source;
		this.viewMode = opts.viewMode;
		this.allFiles = opts.allFiles ?? [];
		this.onSearchText = opts.onSearchText;
		this.cursor = Math.min(Math.max(0, opts.initialIndex ?? 0), Math.max(0, this.files.length - 1));
		if (opts.initialSearch) this.openSearch();
		if (opts.initialTextQuery) this.openTextSearch(opts.initialTextQuery, opts.initialTextPath, opts.initialTextLineNo, opts.initialTextResults);
		if (opts.onLoadUntracked) this.loadUntracked(opts.onLoadUntracked);
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedKey = "";
		this.themeEpoch++;
	}

	render(width: number): string[] {
		const h = Math.max(5, this.tui.terminal.rows);
		const key = this.cacheKey(width, h);
		if (
			this.cachedWidth === width &&
			this.cachedHeight === h &&
			this.cachedKey === key &&
			this.cachedLines.length > 0
		) {
			return this.cachedLines;
		}
		const bodyHeight = Math.max(1, h - 2 - (this.search?.height ?? 0));
		// scrollTop is independent of the cursor in mouse-wheel mode; clamp
		// only to a valid range here. Keyboard navigation methods call
		// `ensureCursorVisible()` explicitly to pull the viewport along.
		const maxTop = Math.max(0, this.files.length - 1);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxTop));

		const header = this.renderHeader(width);
		const body = this.renderBody(width, bodyHeight);
		const searchLines = this.search ? this.search.render(this.theme, width) : [];
		const footer = this.renderFooter(width);
		const lines = [header, ...body, ...searchLines, footer];

		this.cachedWidth = width;
		this.cachedHeight = h;
		this.cachedKey = key;
		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): void {
		if (this.search) {
			if (this.search.handleInput(data)) {
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}
		if (data === "?") return this.openTextSearch();
		if (data === "/") return this.done({ kind: "find-files" });
		if (matchesKey(data, "escape")) return this.done({ kind: "quit" });
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			if (this.files.length === 0) return;
			this.done({ kind: "open-path", path: this.files[this.cursor]!.displayPath });
			return;
		}
		if (matchesKey(data, "down") || data === "j") return this.move(1);
		if (matchesKey(data, "up") || data === "k") return this.move(-1);
		if (matchesKey(data, "home") || data === "g") return this.jumpTo(0);
		if (matchesKey(data, "end") || data === "G") return this.jumpTo(this.files.length - 1);
		if (matchesKey(data, "pageDown") || data === " ") return this.move(this.pageSize());
		if (matchesKey(data, "pageUp") || data === "b") return this.move(-this.pageSize());
		if (data === "q" || data === "Q") return this.done({ kind: "quit" });
		if (data === "r") return this.done({ kind: "refresh" });
		if (data === "f") return this.done({ kind: "toggle-full" });
		if (data === "s") return this.done({ kind: "toggle-source" });
		if (data === "+" || data === "=") return this.done({ kind: "context-change", delta: 1 });
		if (data === "-" || data === "_") return this.done({ kind: "context-change", delta: -1 });
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.search) return { handled: true };
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			if (delta !== 0) this.scrollBy(delta);
			return { handled: true, render: true };
		}
		if (event.type === "click" && event.button === "left") {
			const idx = this.indexAtY(event.y);
			if (idx !== undefined) {
				if ((event.clickCount ?? 1) >= 2 && idx === this.cursor) {
					// Double-click opens the file.
					this.done({ kind: "open-path", path: this.files[idx]!.displayPath });
					return { handled: true, focus: true, render: true };
				}
				if (idx !== this.cursor) {
					this.cursor = idx;
					this.invalidate();
					this.tui.requestRender();
				}
			}
			return { handled: true, focus: true, render: true };
		}
		return undefined;
	}

	private async loadUntracked(load: () => Promise<FileDiff[]>): Promise<void> {
		this.loadingUntracked = true;
		this.invalidate();
		this.tui.requestRender();
		try {
			this.files = await load();
			this.cursor = clamp(this.cursor, 0, Math.max(0, this.files.length - 1));
		} catch {
			// Keep the fast tracked-file list when the deferred scan fails.
		} finally {
			this.loadingUntracked = false;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	private openTextSearch(initialQuery = "", initialPath?: string, initialLineNo?: number, initialResults: TextSearchResult[] = []): void {
		if (!this.onSearchText) return;
		let results: TextSearchResult[] = [...initialResults];
		const cancel = () => {
			this.textSearchGeneration++;
			this.cancelTextSearch?.();
			this.cancelTextSearch = null;
			if (this.textSearchTimer) clearTimeout(this.textSearchTimer);
			if (this.textResultTimer) clearTimeout(this.textResultTimer);
			this.textSearchTimer = null;
			this.textResultTimer = null;
			this.textSearchBusy = false;
		};
		this.search = new SearchPanel([], (rowIndex) => {
			const result = results[rowIndex]!;
			this.done({ kind: "open-path", path: result.path, lineNo: result.lineNo, resumeTextQuery: this.search?.queryText, resumeTextPath: result.path, resumeTextLineNo: result.lineNo, resumeTextResults: results });
		}, () => {
			cancel();
			this.search = null;
			this.invalidate();
			this.tui.requestRender();
		}, 8, {
			hint: "Enter open · ↑↓ navigate · Esc cancel",
			onQueryChange: (query) => {
				cancel();
				const generation = this.textSearchGeneration;
				results = [];
				this.textSearchTruncated = false;
				this.search?.setItems([]);
				if (!query) return;
				this.textSearchBusy = true;
				this.textSearchTimer = setTimeout(() => {
					if (generation !== this.textSearchGeneration) return;
					this.cancelTextSearch = this.onSearchText!(query, (match) => {
						if (generation !== this.textSearchGeneration || results.length >= 1000) return;
						results.push(match);
						if (results.length === 1000) {
							this.textSearchTruncated = true;
							this.cancelTextSearch?.();
							this.cancelTextSearch = null;
							this.textSearchBusy = false;
						}
						if (this.textResultTimer) return;
						this.textResultTimer = setTimeout(() => {
							this.textResultTimer = null;
							this.search?.setItems(results.map((item, rowIndex) => ({ rowIndex, text: `${item.path}:${item.lineNo}: ${item.text}`, lineNo: item.lineNo, side: " " })));
							const restoredIndex = results.findIndex((item) => item.path === initialPath && item.lineNo === initialLineNo);
							if (restoredIndex >= 0) this.search?.selectRowIndex(restoredIndex);
							this.invalidate();
							this.tui.requestRender();
						}, 40);
					}, () => { if (generation === this.textSearchGeneration) { this.textSearchBusy = false; this.invalidate(); this.tui.requestRender(); } });
				}, 120);
			},
		});
		if (initialResults.length > 0) {
			this.search.setItems(results.map((item, rowIndex) => ({ rowIndex, text: `${item.path}:${item.lineNo}: ${item.text}`, lineNo: item.lineNo, side: " " })));
		}
		if (initialQuery) this.search.setQuery(initialQuery, initialResults.length === 0);
		const cachedSelection = results.findIndex((item) => item.path === initialPath && item.lineNo === initialLineNo);
		if (cachedSelection >= 0) this.search.selectRowIndex(cachedSelection);
		this.invalidate();
		this.tui.requestRender();
	}

	private openSearch(): void {
		const items = this.allFiles.map((text, rowIndex) => ({ rowIndex, text, lineNo: undefined, side: " " as const }));
		this.search = new SearchPanel(
			items,
			(rowIndex) => this.done({ kind: "open-path", path: this.allFiles[rowIndex]! }),
			() => {
				this.search = null;
				this.invalidate();
				this.tui.requestRender();
			},
			8,
			{ hint: "Enter open · ↑↓ navigate · Esc cancel" },
		);
		this.invalidate();
		this.tui.requestRender();
	}

	private indexAtY(y: number): number | undefined {
		if (y <= 0) return undefined; // header
		const h = Math.max(5, this.tui.terminal.rows);
		const bodyHeight = Math.max(1, h - 2);
		const bodyRow = y - 1;
		if (bodyRow < 0 || bodyRow >= bodyHeight) return undefined;
		const idx = this.scrollTop + bodyRow;
		if (idx < 0 || idx >= this.files.length) return undefined;
		return idx;
	}

	// ------------------------------------------------------------- private
	private cacheKey(width: number, h: number): string {
		return [width, h, this.themeEpoch, this.cursor, this.scrollTop, this.loadingUntracked, this.source, this.viewMode.kind, this.viewMode.kind === "hunks" ? this.viewMode.context : 0, this.files.length].join(":");
	}

	private renderHeader(width: number): string {
		const t = this.theme;
		const modeStr = this.viewMode.kind === "full" ? "full" : `hunks \u00b1${this.viewMode.context}`;
		const left = `${t.fg("accent", t.bold("/diff"))} ${t.fg("dim", `(${this.files.length} file${this.files.length === 1 ? "" : "s"}${this.loadingUntracked ? " · scanning untracked…" : ""})`)}`;
		const right = t.fg("dim", `[${this.source} \u00b7 ${modeStr}]`);
		return layoutLeftRight(left, right, width);
	}

	private renderFooter(width: number): string {
		const t = this.theme;
		const text = this.search
			? this.textSearchTruncated
				? "showing first 1000 matches · ↑↓ navigate · Enter open · Esc cancel"
				: this.textSearchBusy
					? "searching text… · ↑↓ navigate · Enter open · Esc cancel"
					: "type to search · ↑↓ navigate · Enter open · Esc cancel"
			: "j k move · Enter open · / find file · ? find text · f full · s source · + - ctx · r refresh · q quit";
		return padLine(t.fg("dim", truncateToWidth(" " + text, width)), width);
	}

	private renderBody(width: number, h: number): string[] {
		const out: string[] = [];
		const end = Math.min(this.files.length, this.scrollTop + h);
		for (let i = this.scrollTop; i < end; i++) {
			out.push(this.renderRow(this.files[i]!, i, width));
		}
		while (out.length < h) out.push(padLine(this.theme.fg("dim", "~"), width));
		return out;
	}

	private renderRow(file: FileDiff, index: number, width: number): string {
		const t = this.theme;
		const isCursor = index === this.cursor;
		const marker = isCursor ? t.fg("accent", "\u25b6 ") : "  ";
		const badge = renderStatusBadge(file, t);
		const stats = renderStats(file, t);
		const bodyRaw = ` ${badge}  ${file.displayPath}  ${stats}`;
		const line = padLine(`${marker}${truncateToWidth(bodyRaw, width - visibleWidth(marker))}`, width);
		if (isCursor) return t.style(line, { inverse: true, bold: true });
		return line;
	}

	private move(delta: number): void {
		if (this.files.length === 0) return;
		this.cursor = clamp(this.cursor + delta, 0, this.files.length - 1);
		this.ensureCursorVisible();
		this.invalidate();
		this.tui.requestRender();
	}

	/**
	 * Scroll the file list independently of the cursor — used by the mouse
	 * wheel. If the cursor is scrolled off-screen the user can click a visible
	 * row to re-anchor it.
	 */
	private scrollBy(delta: number): void {
		if (this.files.length === 0) return;
		const maxTop = Math.max(0, this.files.length - 1);
		const next = clamp(this.scrollTop + delta, 0, maxTop);
		if (next === this.scrollTop) return;
		this.scrollTop = next;
		this.invalidate();
		this.tui.requestRender();
	}

	private ensureCursorVisible(): void {
		const h = Math.max(5, this.tui.terminal.rows);
		const bodyHeight = Math.max(1, h - 2);
		this.scrollTop = clampScroll(this.scrollTop, this.cursor, bodyHeight, this.files.length);
	}

	private jumpTo(idx: number): void {
		if (this.files.length === 0) return;
		this.cursor = clamp(idx, 0, this.files.length - 1);
		this.ensureCursorVisible();
		this.invalidate();
		this.tui.requestRender();
	}

	private pageSize(): number {
		return Math.max(1, Math.floor((this.tui.terminal.rows - 2) / 2));
	}

	dispose(): void {
		this.cancelTextSearch?.();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderStatusBadge(file: FileDiff, t: Theme): string {
	switch (file.status) {
		case "added":
			return t.fg("toolDiffAdded", "[+]");
		case "untracked":
			return t.fg("toolDiffAdded", "[?]");
		case "deleted":
			return t.fg("toolDiffRemoved", "[-]");
		case "modified":
			return t.fg("warning", "[M]");
		case "renamed":
			return t.fg("warning", "[R]");
		case "clean":
			return t.fg("dim", "[ ]");
	}
}

function renderStats(file: FileDiff, t: Theme): string {
	if (file.note) return t.fg("dim", `(${file.note})`);
	if (file.binary) return t.fg("dim", "(binary)");
	let adds = 0;
	let dels = 0;
	for (const h of file.hunks) {
		for (const l of h.lines) {
			if (l.kind === "add") adds++;
			else if (l.kind === "del") dels++;
		}
	}
	return `${t.fg("toolDiffAdded", `+${adds}`)} ${t.fg("toolDiffRemoved", `-${dels}`)}`;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function clampScroll(scrollTop: number, cursor: number, h: number, total: number): number {
	let st = scrollTop;
	if (cursor < st) st = cursor;
	if (cursor >= st + h) st = cursor - h + 1;
	st = Math.max(0, Math.min(st, Math.max(0, total - 1)));
	return st;
}

function layoutLeftRight(left: string, right: string, width: number): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + rw + 1 >= width) return truncateToWidth(left, width - rw) + right;
	return left + " ".repeat(width - lw - rw) + right;
}

function padLine(line: string, width: number): string {
	const v = visibleWidth(line);
	if (v >= width) return truncateToWidth(line, width);
	return line + " ".repeat(width - v);
}
