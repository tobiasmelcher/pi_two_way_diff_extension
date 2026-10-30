/**
 * The main /diff view component.
 *
 * Fullscreen interactive component (used as `ctx.ui.custom(..., { overlay: true,
 * overlayOptions: { width: "100%", maxHeight: "100%" } })`). Owns navigation
 * state, view mode, selection, and embedded inputs for prompting and jumping
 * to source lines.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";

import { buildVirtualRows, renderDiffViewport, shouldUseSideBySide, type VirtualRow } from "../render.ts";
import type { DiffSource, FileDiff, ViewMode } from "../types.ts";
import { PromptInput } from "./PromptInput.ts";
import { SearchPanel, type SearchItem } from "./SearchPanel.ts";

/** The context lines the user can cycle through with `+` / `-`. */
const CONTEXT_LADDER = [0, 1, 2, 3, 5, 8, 12, 20];

export interface DiffViewResult {
	kind: "quit" | "back" | "prompt";
	/** Only for kind=="prompt" */
	promptText?: string;
	/** Only for kind=="prompt" — contextual snippet to prepend to the user text */
	snippet?: string;
	/** The file we were showing when we exited (used to restore list cursor). */
	fileIndex?: number;
}

export interface DiffViewSources {
	git: FileDiff[];
	session?: FileDiff[]; // optional; may be undefined
}

export interface DiffViewOptions {
	files: FileDiff[]; // files for the current source
	source: DiffSource;
	viewMode: ViewMode;
	/** Which file to open initially (0-based). */
	initialFileIndex?: number;
	/** New/source line to select when opening from full-text search. */
	initialLineNo?: number;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	done: (result: DiffViewResult | undefined) => void;
	/** Called when the user asks to reload. Return the fresh file list. */
	onRefresh: () => Promise<FileDiff[]>;
	/**
	 * Called when the user toggles between hunks ↔ full file or changes the
	 * context lines. Return the fresh file list for the new mode. The current
	 * source does not change.
	 */
	onChangeViewMode: (newMode: ViewMode) => Promise<FileDiff[]>;
	/**
	 * Called when the user toggles source. Return the fresh file list for the
	 * new source. If the alternate source is unavailable (e.g. no session
	 * data), return undefined and the view stays on the current source.
	 */
	onToggleSource: (newSource: DiffSource) => Promise<FileDiff[] | undefined>;
}

/**
 * Internal mode: `normal` = navigation, `visual` = selection extend,
 * `prompt` = PromptInput is active and consuming keys.
 */
type Mode = "normal" | "visual" | "prompt" | "lineJump" | "search";

export class DiffViewComponent implements Component, Focusable {
	focused = true;
	wantsKeyRelease = false;

	private readonly opts: DiffViewOptions;
	private files: FileDiff[];
	private source: DiffSource;
	private viewMode: ViewMode;
	private fileIndex = 0;
	private rows: VirtualRow[] = [];
	private cursorRow = 0;
	private scrollTop = 0;
	private scrollX = 0;
	/** Temporarily show the new/source pane at full width in a two-pane diff. */
	private hideLeft = false;
	private selectionAnchor = -1; // -1 = no selection
	private mode: Mode = "normal";
	private busy = false; // disables keys during async refresh
	private statusMessage: string | undefined;
	private statusMessageUntil = 0;
	private prompt: PromptInput | null = null;
	private lineJump: PromptInput | null = null;
	private search: SearchPanel | null = null;

	// Caching
	private cachedWidth = -1;
	private cachedHeight = -1;
	private cachedKey = "";
	private cachedLines: string[] = [];
	private themeEpoch = 0;

	constructor(opts: DiffViewOptions) {
		this.opts = opts;
		this.files = opts.files;
		this.source = opts.source;
		this.viewMode = opts.viewMode;
		this.fileIndex = clamp(opts.initialFileIndex ?? 0, 0, Math.max(0, this.files.length - 1));
		this.rebuildRows();
		if (opts.initialLineNo !== undefined) {
			const row = this.findNewLine(opts.initialLineNo);
			if (row !== undefined) {
				this.cursorRow = row;
				this.scrollTop = row;
			}
		}
	}

	// ------------------------------------------------------------------- API
	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedHeight = -1;
		this.cachedKey = "";
		this.themeEpoch++;
	}

	// -------------------------------------------------------- Rendering
	render(width: number): string[] {
		const h = Math.max(5, this.opts.tui.terminal.rows);
		const key = this.cacheKey(width, h);
		if (
			this.cachedWidth === width &&
			this.cachedHeight === h &&
			this.cachedKey === key &&
			this.cachedLines.length > 0
		) {
			return this.cachedLines;
		}

		// Reserve space for the search panel if it's open.
		const searchHeight = this.mode === "search" && this.search ? this.search.height : 0;

		// Header 1 row + body + searchPanel + footer 1 row = h.
		const bodyHeight = Math.max(1, h - 2 - searchHeight);

		// In search mode we auto-follow the active match (live preview). In
		// normal mode scrollTop is independent of the cursor — it is adjusted
		// explicitly when the user issues a cursor move (keyboard), and left
		// alone when the user wheel-scrolls or asks for a specific scrollTop.
		if (this.mode === "search" && this.search?.activeRowIndex !== undefined) {
			this.scrollTop = clampScroll(
				this.scrollTop,
				this.search.activeRowIndex,
				bodyHeight,
				this.rows.length,
			);
		} else {
			// Just clamp scrollTop to a valid range so we never render past the end.
			const maxTop = Math.max(0, this.rows.length - 1);
			this.scrollTop = clamp(this.scrollTop, 0, maxTop);
		}
		// Decide which row to highlight. In search mode we overlay the active
		// match on the live cursor so the user sees context as they navigate.
		const effectiveCursor =
			this.mode === "search" && this.search?.activeRowIndex !== undefined
				? this.search.activeRowIndex
				: this.cursorRow;

		const headerLine = this.renderHeader(width);
		const bodyLines = renderDiffViewport({
			theme: this.opts.theme,
			width,
			bodyHeight,
			rows: this.rows,
			scrollTop: this.scrollTop,
			cursorRow: effectiveCursor,
			selection: this.getSelection() ?? undefined,
			sideBySide: shouldUseSideBySide(width),
			language: this.files[this.fileIndex]?.displayPath.toLowerCase().endsWith(".java") ? "java" : undefined,
			hideLeft: this.hideLeft,
			scrollX: this.scrollX,
		});
		const searchLines = searchHeight > 0 && this.search ? this.search.render(this.opts.theme, width) : [];
		const footerLine = this.renderFooter(width);

		const lines = [headerLine, ...bodyLines, ...searchLines, footerLine];
		this.cachedWidth = width;
		this.cachedHeight = h;
		this.cachedKey = key;
		this.cachedLines = lines;
		return lines;
	}

	private cacheKey(width: number, height: number): string {
		return [
			width,
			height,
			this.themeEpoch,
			this.fileIndex,
			this.scrollTop,
			this.scrollX,
			this.hideLeft,
			this.cursorRow,
			this.selectionAnchor,
			this.mode,
			this.source,
			this.viewMode.kind,
			this.viewMode.kind === "hunks" ? this.viewMode.context : 0,
			this.statusMessage ?? "",
			this.statusMessageUntil,
			this.prompt?.value ?? "",
			this.lineJump?.value ?? "",
			this.search?.queryText ?? "",
			this.search?.selectedIndex ?? -1,
			this.search?.matchCount ?? 0,
		].join(":");
	}

	private renderHeader(width: number): string {
		const t = this.opts.theme;
		const file = this.files[this.fileIndex];
		const total = this.files.length;
		const name = file?.displayPath ?? "<no files>";
		const hunkTotal = file?.hunks.length ?? 0;
		const curHunk = this.currentHunkIndex();
		const modeStr =
			this.viewMode.kind === "full" ? "full" : `hunks \u00b1${this.viewMode.context}`;
		const scrollStr = this.scrollX > 0 ? ` \u00b7 col +${this.scrollX}` : "";
		const paneStr = this.hideLeft ? " \u00b7 new only" : "";
		const headerLeft =
			`${t.fg("accent", t.bold("/diff"))} ` +
			`${t.fg("text", name)}  ` +
			t.fg(
				"dim",
				`(file ${this.fileIndex + 1}/${Math.max(1, total)} \u00b7 hunk ${curHunk + 1}/${Math.max(1, hunkTotal)})`,
			);
		const headerRight = t.fg("dim", `[${this.source} \u00b7 ${modeStr}${paneStr}${scrollStr}]`);
		return padRightWithRight(headerLeft, headerRight, width, t);
	}

	private renderFooter(width: number): string {
		const t = this.opts.theme;
		let text: string;
		if (this.busy) {
			text = "Working \u2026";
		} else if (this.mode === "prompt" && this.prompt) {
			// The prompt input renders directly as the footer.
			const promptLine = this.prompt.render(t, Math.max(1, width - 1));
			return padAnsi(" " + promptLine, width);
		} else if (this.mode === "lineJump" && this.lineJump) {
			const inputLine = this.lineJump.render(t, Math.max(1, width - 1));
			return padAnsi(" " + inputLine, width);
		} else if (this.mode === "visual") {
			text = "j k extend \u00b7 p prompt \u00b7 Esc cancel";
		} else if (this.mode === "search") {
			text = "type to search \u00b7 \u2191\u2193 navigate matches \u00b7 Enter jump \u00b7 Esc cancel";
		} else {
			text =
				"j k scroll \u00b7 Ctrl+g line \u00b7 \u2190 \u2192 h-scroll \u00b7 l hide/show old \u00b7 n N change \u00b7 / search \u00b7 Tab file \u00b7 h back \u00b7 v select \u00b7 p prompt \u00b7 f full \u00b7 + - ctx \u00b7 r refresh \u00b7 q quit";
		}
		if (this.statusMessage && Date.now() < this.statusMessageUntil) {
			text = `${this.statusMessage}   \u2014   ${text}`;
		}
		const styled = t.fg("dim", truncateToWidth(" " + text, width));
		return padAnsi(styled, width);
	}

	// --------------------------------------------------- Input handling
	handleInput(data: string): void {
		if (this.busy) return;

		// Prompt mode absorbs almost everything.
		if (this.mode === "prompt" && this.prompt) {
			const handled = this.prompt.handleInput(data);
			if (handled) {
				this.invalidate();
				this.opts.tui.requestRender();
			}
			return;
		}

		if (this.mode === "lineJump" && this.lineJump) {
			const handled = this.lineJump.handleInput(data);
			if (handled) {
				this.invalidate();
				this.opts.tui.requestRender();
			}
			return;
		}

		// Search mode: the panel owns the input (query editing + match nav).
		if (this.mode === "search" && this.search) {
			const handled = this.search.handleInput(data);
			if (handled) {
				this.invalidate();
				this.opts.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "ctrl+g")) {
			this.openLineJump();
			return;
		}

		if (matchesKey(data, "escape")) {
			if (this.mode === "visual") {
				this.selectionAnchor = -1;
				this.mode = "normal";
				this.invalidate();
				this.opts.tui.requestRender();
				return;
			}
			// From a diff view, Esc returns to the file list.
			this.opts.done({ kind: "back", fileIndex: this.fileIndex });
			return;
		}

		switch (data) {
			case "q":
			case "Q":
				this.opts.done({ kind: "quit" });
				return;
			case "h":
				this.opts.done({ kind: "back", fileIndex: this.fileIndex });
				return;
			case "j":
				this.moveCursor(1);
				return;
			case "k":
				this.moveCursor(-1);
				return;
			case "n":
				this.jumpHunk(1);
				return;
			case "N":
				this.jumpHunk(-1);
				return;
			case "g":
				this.jumpToTop();
				return;
			case "G":
				this.jumpToBottom();
				return;
			case "v":
				this.toggleVisual();
				return;
			case "p":
				this.openPrompt();
				return;
			case "/":
				this.openSearch();
				return;
			case "f":
				this.toggleFullFile();
				return;
			case "l":
				this.toggleLeftPane();
				return;
			case "s":
				this.toggleSource();
				return;
			case "r":
				this.refresh();
				return;
			case "+":
			case "=":
				this.changeContext(+1);
				return;
			case "-":
			case "_":
				this.changeContext(-1);
				return;
			case " ":
				this.moveCursorPage(+1);
				return;
			case "b":
				this.moveCursorPage(-1);
				return;
		}

		if (matchesKey(data, "down")) return this.moveCursor(1);
		if (matchesKey(data, "up")) return this.moveCursor(-1);
		if (matchesKey(data, "left")) return this.scrollHorizontal(-1);
		if (matchesKey(data, "right")) return this.scrollHorizontal(1);
		if (matchesKey(data, "home")) return this.resetHorizontal();
		if (matchesKey(data, "pageDown")) return this.moveCursorPage(+1);
		if (matchesKey(data, "pageUp")) return this.moveCursorPage(-1);
		if (matchesKey(data, "tab")) return this.jumpFile(+1);
		if (matchesKey(data, "shift+tab")) return this.jumpFile(-1);
	}

	// --------------------------------------------------- Mouse
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.busy) return { handled: true };

		// While either footer input is active we only consume wheel to keep the
		// background from scrolling; clicks and anything else stay with pi.
		if (this.mode === "prompt" || this.mode === "lineJump") {
			if (event.type === "wheel") return { handled: true };
			return undefined;
		}

		// Search mode: route to the search panel.
		if (this.mode === "search" && this.search) {
			return this.handleMouseInSearch(event);
		}

		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			if (delta === 0) return { handled: true };
			if (event.shift) {
				// Shift+wheel = horizontal scroll.
				this.scrollHorizontal(delta > 0 ? 1 : -1);
			} else {
				// Vertical wheel moves the viewport only; the cursor stays put
				// so the user can scroll around and then click to re-anchor.
				this.scrollBy(delta);
			}
			return { handled: true, render: true };
		}

		if (event.type === "click" && event.button === "left") {
			const rowIndex = this.rowIndexAtY(event.y);
			if (rowIndex !== undefined && rowIndex !== this.cursorRow) {
				this.cursorRow = rowIndex;
				// If visual mode is active, extend the selection by moving the
				// cursor; otherwise just land there.
				this.invalidate();
				this.opts.tui.requestRender();
			}
			return { handled: true, focus: true, render: true };
		}

		return undefined;
	}

	/**
	 * Mouse events while the search panel is open: wheel navigates matches,
	 * clicks inside the panel select / jump; clicks outside stay in the diff
	 * body and reposition the cursor (useful preview).
	 */
	private handleMouseInSearch(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.search) return undefined;
		const panelTopY = this.panelTopY();
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			if (delta === 0) return { handled: true };
			// Any wheel delta nudges the match selection by 1 unit (match lists
			// are short; multi-step wheels on a tall list still feel natural).
			const keyData = delta > 0 ? "\x1b[B" : "\x1b[A";
			for (let i = 0; i < Math.max(1, Math.abs(delta)); i++) {
				this.search.handleInput(keyData);
			}
			this.invalidate();
			this.opts.tui.requestRender();
			return { handled: true, render: true };
		}
		if (event.type === "click" && event.button === "left") {
			if (event.y < panelTopY) {
				// Click fell on the diff body.
				const rowIndex = this.rowIndexAtY(event.y);
				if (rowIndex !== undefined) {
					this.cursorRow = rowIndex;
					this.invalidate();
					this.opts.tui.requestRender();
				}
				return { handled: true, focus: true, render: true };
			}
			// Click fell inside the panel: synthesize Enter if a match row was
			// clicked (double-click behaves the same way).
			this.search.handleInput("\r");
			return { handled: true, render: true };
		}
		return undefined;
	}

	/**
	 * Map a local y coordinate to a virtual-row index inside the body, or
	 * undefined if y is in the header, footer, or search panel area.
	 */
	private rowIndexAtY(y: number): number | undefined {
		if (y <= 0) return undefined; // header
		const h = Math.max(5, this.opts.tui.terminal.rows);
		const searchHeight = this.mode === "search" && this.search ? this.search.height : 0;
		const bodyHeight = Math.max(1, h - 2 - searchHeight);
		const bodyRow = y - 1;
		if (bodyRow < 0 || bodyRow >= bodyHeight) return undefined;
		const idx = this.scrollTop + bodyRow;
		if (idx < 0 || idx >= this.rows.length) return undefined;
		return idx;
	}

	private panelTopY(): number {
		const h = Math.max(5, this.opts.tui.terminal.rows);
		const searchHeight = this.mode === "search" && this.search ? this.search.height : 0;
		return h - 1 - searchHeight;
	}

	// ---------------------------------------- Navigation primitives
	private moveCursor(delta: number): void {
		if (this.rows.length === 0) return;
		this.cursorRow = clamp(this.cursorRow + delta, 0, this.rows.length - 1);
		this.ensureCursorVisible();
		this.invalidate();
		this.opts.tui.requestRender();
	}

	/**
	 * Scroll the viewport by `delta` rows (positive = down). Leaves the
	 * cursor alone — this is the mouse-wheel path.
	 */
	private scrollBy(delta: number): void {
		if (this.rows.length === 0) return;
		const maxTop = Math.max(0, this.rows.length - 1);
		const next = clamp(this.scrollTop + delta, 0, maxTop);
		if (next === this.scrollTop) return;
		this.scrollTop = next;
		this.invalidate();
		this.opts.tui.requestRender();
	}

	/** Adjust scrollTop so cursorRow is on screen. */
	private ensureCursorVisible(): void {
		const h = Math.max(5, this.opts.tui.terminal.rows);
		const searchHeight = this.mode === "search" && this.search ? this.search.height : 0;
		const bodyHeight = Math.max(1, h - 2 - searchHeight);
		this.scrollTop = clampScroll(this.scrollTop, this.cursorRow, bodyHeight, this.rows.length);
	}

	private moveCursorPage(dir: 1 | -1): void {
		const page = Math.max(1, Math.floor((this.cachedHeight - 2) / 2));
		this.moveCursor(dir * page);
	}

	/**
	 * Scroll the diff body horizontally by `dir` steps. Step size adapts to
	 * the terminal width so each press moves roughly 1/4 of a visible pane,
	 * which feels right on both narrow and wide terminals.
	 */
	private scrollHorizontal(dir: 1 | -1): void {
		const width = this.cachedWidth > 0 ? this.cachedWidth : (this.opts.tui.terminal.columns || 80);
		const approxPane = this.hideLeft || !shouldUseSideBySide(width)
			? width
			: Math.floor((width - 2) / 2);
		const step = Math.max(4, Math.floor(approxPane / 4));
		const next = Math.max(0, this.scrollX + dir * step);
		if (next === this.scrollX) return;
		this.scrollX = next;
		this.invalidate();
		this.opts.tui.requestRender();
	}

	private resetHorizontal(): void {
		if (this.scrollX === 0) return;
		this.scrollX = 0;
		this.invalidate();
		this.opts.tui.requestRender();
	}

	private jumpToTop(): void {
		this.cursorRow = 0;
		this.scrollTop = 0;
		this.scrollX = 0;
		this.invalidate();
		this.opts.tui.requestRender();
	}

	private jumpToBottom(): void {
		this.cursorRow = Math.max(0, this.rows.length - 1);
		this.ensureCursorVisible();
		this.invalidate();
		this.opts.tui.requestRender();
	}

	private jumpHunk(dir: 1 | -1): void {
		if (this.rows.length === 0) return;
		const target = findNextChangeRegion(this.rows, this.cursorRow, dir);
		if (target < 0) {
			this.setStatus(dir > 0 ? "No more changes" : "No previous changes");
			return;
		}
		this.cursorRow = target;
		this.ensureCursorVisible();
		this.invalidate();
		this.opts.tui.requestRender();
	}

	private jumpFile(dir: 1 | -1): void {
		if (this.files.length === 0) return;
		const next = this.fileIndex + dir;
		if (next < 0 || next >= this.files.length) {
			this.setStatus(dir > 0 ? "Last file" : "First file");
			return;
		}
		this.fileIndex = next;
		this.cursorRow = 0;
		this.scrollTop = 0;
		this.scrollX = 0;
		this.selectionAnchor = -1;
		this.mode = "normal";
		this.rebuildRows();
		this.invalidate();
		this.opts.tui.requestRender();
	}

	// ------------------------------------------------- Mode switches
	private toggleVisual(): void {
		if (this.mode === "visual") {
			this.selectionAnchor = -1;
			this.mode = "normal";
		} else {
			this.selectionAnchor = this.cursorRow;
			this.mode = "visual";
		}
		this.invalidate();
		this.opts.tui.requestRender();
	}

	private openPrompt(): void {
		if (!this.canSelectCurrent() && this.selectionAnchor < 0) {
			this.setStatus("Move cursor to a code line first");
			return;
		}
		const snippet = this.buildSnippet();
		this.mode = "prompt";
		this.prompt = new PromptInput("Ask about this snippet:", (text) => {
			this.mode = "normal";
			const t = text.trim();
			this.prompt = null;
			if (!t) {
				this.selectionAnchor = -1;
				this.invalidate();
				this.opts.tui.requestRender();
				return;
			}
			this.opts.done({ kind: "prompt", promptText: t, snippet });
		}, () => {
			this.mode = "normal";
			this.prompt = null;
			this.invalidate();
			this.opts.tui.requestRender();
		});
		this.invalidate();
		this.opts.tui.requestRender();
	}

	/**
	 * Open a line-number input. A full-file view is needed because a target may
	 * sit outside the current hunks, so expand first just as source search does.
	 */
	private openLineJump(): void {
		if (this.viewMode.kind === "full") {
			this.beginLineJump();
			return;
		}
		this.busy = true;
		this.setStatus("Expanding to full file for line jump…");
		this.invalidate();
		this.opts.tui.requestRender();
		void (async () => {
			try {
				const newMode: ViewMode = { kind: "full" };
				const newFiles = await this.opts.onChangeViewMode(newMode);
				this.viewMode = newMode;
				this.files = newFiles;
				this.fileIndex = clamp(this.fileIndex, 0, Math.max(0, this.files.length - 1));
				this.rebuildRows();
				this.cursorRow = clamp(this.cursorRow, 0, Math.max(0, this.rows.length - 1));
				this.selectionAnchor = -1;
				this.beginLineJump();
			} catch (err) {
				this.setStatus(`Error: ${(err as Error).message}`);
			} finally {
				this.busy = false;
				this.invalidate();
				this.opts.tui.requestRender();
			}
		})();
	}

	private beginLineJump(): void {
		this.mode = "lineJump";
		this.lineJump = new PromptInput("Go to line:", (text) => this.submitLineJump(text), () => {
			this.mode = "normal";
			this.lineJump = null;
			this.invalidate();
			this.opts.tui.requestRender();
		});
		this.invalidate();
		this.opts.tui.requestRender();
	}

	private submitLineJump(text: string): void {
		this.mode = "normal";
		this.lineJump = null;
		if (!/^[1-9]\d*$/.test(text)) {
			this.setStatus("Enter a positive line number");
			return;
		}
		const lineNo = Number(text);
		if (!Number.isSafeInteger(lineNo)) {
			this.setStatus("Line number is too large");
			return;
		}
		const rowIndex = this.findNewLine(lineNo);
		if (rowIndex === undefined) {
			this.setStatus(`Line ${lineNo} is not present in the new file`);
			return;
		}
		this.jumpToRow(rowIndex);
	}

	/** Return the virtual row containing this 1-based line in the new file. */
	private findNewLine(lineNo: number): number | undefined {
		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			if (row?.kind === "diff" && row.alignedRow?.right.newLineNo === lineNo) return i;
		}
		return undefined;
	}

	private openSearch(): void {
		if (this.viewMode.kind === "full") {
			this.beginSearch();
			return;
		}
		// Need to expand to full first so the whole source is searchable.
		this.busy = true;
		this.setStatus("Expanding to full file for search\u2026");
		this.invalidate();
		this.opts.tui.requestRender();
		void (async () => {
			try {
				const newMode: ViewMode = { kind: "full" };
				const newFiles = await this.opts.onChangeViewMode(newMode);
				this.viewMode = newMode;
				this.files = newFiles;
				this.fileIndex = clamp(this.fileIndex, 0, Math.max(0, this.files.length - 1));
				this.rebuildRows();
				this.cursorRow = clamp(this.cursorRow, 0, Math.max(0, this.rows.length - 1));
				this.selectionAnchor = -1;
				this.beginSearch();
			} catch (err) {
				this.setStatus(`Error: ${(err as Error).message}`);
			} finally {
				this.busy = false;
				this.invalidate();
				this.opts.tui.requestRender();
			}
		})();
	}

	/** Build the search items from the current rows and open the panel. */
	private beginSearch(): void {
		const items = this.collectSearchItems();
		if (items.length === 0) {
			this.setStatus("No searchable lines in this file");
			return;
		}
		this.search = new SearchPanel(
			items,
			(rowIndex) => {
				this.jumpToRow(rowIndex);
				this.closeSearch();
			},
			() => this.closeSearch(),
		);
		this.mode = "search";
		this.invalidate();
		this.opts.tui.requestRender();
	}

	private closeSearch(): void {
		this.mode = "normal";
		this.search = null;
		this.invalidate();
		this.opts.tui.requestRender();
	}

	/** Extract one searchable item per diff row (ctx / add / del). */
	private collectSearchItems(): SearchItem[] {
		const items: SearchItem[] = [];
		for (let i = 0; i < this.rows.length; i++) {
			const r = this.rows[i]!;
			if (r.kind !== "diff" || !r.alignedRow) continue;
			const { left, right } = r.alignedRow;
			// Prefer the right (new) side; fall back to left for pure deletions.
			if (right.kind === "add") {
				items.push({ rowIndex: i, text: right.text, lineNo: right.newLineNo, side: "+" });
			} else if (left.kind === "del") {
				items.push({ rowIndex: i, text: left.text, lineNo: left.oldLineNo, side: "-" });
			} else if (left.kind === "ctx") {
				items.push({
					rowIndex: i,
					text: left.text,
					lineNo: left.newLineNo ?? left.oldLineNo,
					side: " ",
				});
			}
		}
		return items;
	}

	/** Place the cursor on the given virtual row and ensure it's in view. */
	private jumpToRow(rowIndex: number): void {
		if (rowIndex < 0 || rowIndex >= this.rows.length) return;
		this.cursorRow = rowIndex;
		this.scrollX = 0; // show the match from the left so it's immediately visible
		this.ensureCursorVisible();
		this.invalidate();
		this.opts.tui.requestRender();
	}

	private toggleLeftPane(): void {
		this.hideLeft = !this.hideLeft;
		this.invalidate();
		this.opts.tui.requestRender();
	}

	private toggleFullFile(): void {
		const next: ViewMode = this.viewMode.kind === "full" ? { kind: "hunks", context: 3 } : { kind: "full" };
		this.changeViewMode(next);
	}

	private changeContext(delta: 1 | -1): void {
		if (this.viewMode.kind !== "hunks") {
			this.setStatus("Switch to hunks view first (press f)");
			return;
		}
		const idx = CONTEXT_LADDER.indexOf(this.viewMode.context);
		const nextIdx = clamp(
			(idx >= 0 ? idx : 3) + delta,
			0,
			CONTEXT_LADDER.length - 1,
		);
		const nextCtx = CONTEXT_LADDER[nextIdx]!;
		if (nextCtx === this.viewMode.context) return;
		this.changeViewMode({ kind: "hunks", context: nextCtx });
	}

	private changeViewMode(newMode: ViewMode): void {
		this.busy = true;
		this.invalidate();
		this.opts.tui.requestRender();
		void (async () => {
			try {
				const newFiles = await this.opts.onChangeViewMode(newMode);
				this.viewMode = newMode;
				this.files = newFiles;
				this.fileIndex = clamp(this.fileIndex, 0, Math.max(0, this.files.length - 1));
				this.rebuildRows();
				this.cursorRow = clamp(this.cursorRow, 0, Math.max(0, this.rows.length - 1));
				this.selectionAnchor = -1;
			} catch (err) {
				this.setStatus(`Error: ${(err as Error).message}`);
			} finally {
				this.busy = false;
				this.invalidate();
				this.opts.tui.requestRender();
			}
		})();
	}

	private toggleSource(): void {
		const target: DiffSource = this.source === "git" ? "session" : "git";
		this.busy = true;
		this.invalidate();
		this.opts.tui.requestRender();
		void (async () => {
			try {
				const newFiles = await this.opts.onToggleSource(target);
				if (newFiles === undefined) {
					this.setStatus(`No ${target} data available`);
					return;
				}
				this.source = target;
				this.files = newFiles;
				this.fileIndex = 0;
				this.cursorRow = 0;
				this.scrollTop = 0;
				this.selectionAnchor = -1;
				this.rebuildRows();
			} catch (err) {
				this.setStatus(`Error: ${(err as Error).message}`);
			} finally {
				this.busy = false;
				this.invalidate();
				this.opts.tui.requestRender();
			}
		})();
	}

	private refresh(): void {
		this.busy = true;
		this.setStatus("Refreshing\u2026");
		this.invalidate();
		this.opts.tui.requestRender();
		void (async () => {
			try {
				const newFiles = await this.opts.onRefresh();
				this.files = newFiles;
				this.fileIndex = clamp(this.fileIndex, 0, Math.max(0, this.files.length - 1));
				this.rebuildRows();
				this.cursorRow = clamp(this.cursorRow, 0, Math.max(0, this.rows.length - 1));
				this.selectionAnchor = -1;
				this.setStatus("Refreshed");
			} catch (err) {
				this.setStatus(`Error: ${(err as Error).message}`);
			} finally {
				this.busy = false;
				this.invalidate();
				this.opts.tui.requestRender();
			}
		})();
	}

	// ----------------------------------------- Selection + snippet
	private canSelectCurrent(): boolean {
		return this.rows[this.cursorRow]?.kind === "diff";
	}

	private getSelection(): { fromRow: number; toRow: number } | null {
		if (this.selectionAnchor < 0) return null;
		return { fromRow: this.selectionAnchor, toRow: this.cursorRow };
	}

	private buildSnippet(): string {
		const sel = this.getSelection();
		const from = sel ? Math.min(sel.fromRow, sel.toRow) : this.cursorRow;
		const to = sel ? Math.max(sel.fromRow, sel.toRow) : this.cursorRow;

		const file = this.files[this.fileIndex];
		if (!file) return "";
		const lines: string[] = [];
		let firstNewNo: number | undefined;
		let lastNewNo: number | undefined;
		let firstOldNo: number | undefined;
		let lastOldNo: number | undefined;

		for (let i = from; i <= to; i++) {
			const r = this.rows[i];
			if (!r || r.kind !== "diff" || !r.alignedRow) continue;
			const { left, right } = r.alignedRow;
			if (right.kind === "add") {
				lines.push(`+ ${right.text}`);
				if (firstNewNo === undefined) firstNewNo = right.newLineNo;
				lastNewNo = right.newLineNo ?? lastNewNo;
			} else if (left.kind === "del") {
				lines.push(`- ${left.text}`);
				if (firstOldNo === undefined) firstOldNo = left.oldLineNo;
				lastOldNo = left.oldLineNo ?? lastOldNo;
			} else if (left.kind === "ctx") {
				lines.push(`  ${left.text}`);
				if (firstNewNo === undefined) firstNewNo = left.newLineNo;
				lastNewNo = left.newLineNo ?? lastNewNo;
			}
		}
		if (lines.length === 0) return "";
		const range = formatRange(firstNewNo ?? firstOldNo, lastNewNo ?? lastOldNo);
		const path = file.displayPath;
		return [
			`In \`${path}\`${range ? ` (lines ${range})` : ""}:`,
			"```",
			...lines,
			"```",
		].join("\n");
	}

	private rebuildRows(): void {
		const file = this.files[this.fileIndex];
		this.rows = file ? buildVirtualRows(file) : [];
	}

	private currentHunkIndex(): number {
		for (let i = this.cursorRow; i >= 0; i--) {
			const r = this.rows[i];
			if (r && (r.kind === "hunkHeader" || r.kind === "diff") && r.hunkIndex !== undefined) {
				return r.hunkIndex;
			}
		}
		return 0;
	}

	private setStatus(msg: string, ms = 2000): void {
		this.statusMessage = msg;
		this.statusMessageUntil = Date.now() + ms;
		this.invalidate();
		this.opts.tui.requestRender();
	}

	// ------------------------------------------------------- Lifecycle
	dispose(): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

/**
 * Return true if the row represents a changed line on either side (add/del).
 * Context, pad, headers and spacers are not change rows.
 */
function isChangeRow(row: VirtualRow): boolean {
	if (row.kind !== "diff" || !row.alignedRow) return false;
	const { left, right } = row.alignedRow;
	return left.kind === "del" || right.kind === "add";
}

/**
 * Find the first row of the next (or previous) change region from `cursor`.
 * A region is a maximal run of consecutive change rows. If the cursor sits
 * inside a region, we skip past it first so that `n` really advances.
 */
function findNextChangeRegion(rows: VirtualRow[], cursor: number, dir: 1 | -1): number {
	const inRegion = cursor >= 0 && cursor < rows.length && isChangeRow(rows[cursor]!);
	let i = cursor;
	if (inRegion) {
		// Skip to the end of the current region.
		while (i >= 0 && i < rows.length && isChangeRow(rows[i]!)) i += dir;
	} else {
		i += dir;
	}
	while (i >= 0 && i < rows.length) {
		if (isChangeRow(rows[i]!)) return i;
		i += dir;
	}
	return -1;
}

function clampScroll(scrollTop: number, cursor: number, bodyHeight: number, total: number): number {
	let st = scrollTop;
	if (cursor < st) st = cursor;
	if (cursor >= st + bodyHeight) st = cursor - bodyHeight + 1;
	st = Math.max(0, Math.min(st, Math.max(0, total - 1)));
	return st;
}

function formatRange(a?: number, b?: number): string {
	if (a == null && b == null) return "";
	if (a == null) return `${b}`;
	if (b == null || a === b) return `${a}`;
	return `${a}\u2013${b}`;
}

function padLine(line: string, width: number, _theme: Theme): string {
	return padAnsi(line, width);
}

function padRightWithRight(left: string, right: string, width: number, _theme: Theme): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + rw + 1 >= width) {
		return padAnsi(truncateToWidth(left, width - rw) + right, width);
	}
	return left + " ".repeat(width - lw - rw) + right;
}

function padAnsi(s: string, width: number): string {
	const v = visibleWidth(s);
	if (v >= width) return truncateToWidth(s, width);
	return s + " ".repeat(width - v);
}

function ansiOverhead(s: string): number {
	// Kept for potential future use.
	return s.length - visibleWidth(s);
}
