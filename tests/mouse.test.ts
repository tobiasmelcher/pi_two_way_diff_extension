/**
 * Tests for mouse support on DiffViewComponent and FileListComponent.
 *
 * We don't exercise the full UI pipeline — just construct the components with
 * stand-in TUI/theme and call handleMouse() directly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { TuiMouseEvent } from "@earendil-works/pi-tui";

import { retainFileInView } from "../index.ts";
import { DiffViewComponent } from "../src/ui/DiffViewComponent.ts";
import { FileListComponent } from "../src/ui/FileListComponent.ts";
import type { FileDiff } from "../src/types.ts";

import { fakeTheme, fakeTui } from "./helpers.ts";

function wheel(y: number, delta: number, shift = false): TuiMouseEvent {
	return {
		type: "wheel",
		button: "none",
		x: 10,
		y,
		screenX: 10,
		screenY: y,
		width: 120,
		height: 30,
		shift,
		alt: false,
		ctrl: false,
		wheelDelta: delta,
	};
}

function click(y: number, clickCount = 1): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 10,
		y,
		screenX: 10,
		screenY: y,
		width: 120,
		height: 30,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount,
	};
}

function makeModifiedFile(): FileDiff {
	// 8 add lines so the body has at least ~10 virtual rows.
	const lines = Array.from({ length: 8 }, (_, i) => ({
		kind: "add" as const,
		newLineNo: i + 1,
		text: `line ${i + 1}`,
	}));
	return {
		oldPath: "a.ts",
		newPath: "a.ts",
		displayPath: "a.ts",
		status: "modified",
		hunks: [
			{
				oldStart: 0,
				oldLines: 0,
				newStart: 1,
				newLines: 8,
				header: "@@ -0,0 +1,8 @@",
				lines,
			},
		],
	};
}

function makeFiles(n = 5): FileDiff[] {
	return Array.from({ length: n }, (_, i) => ({
		oldPath: `f${i}.ts`,
		newPath: `f${i}.ts`,
		displayPath: `f${i}.ts`,
		status: "modified" as const,
		hunks: [],
	}));
}

function makeDiffView(initialFile?: FileDiff) {
	const files = [initialFile ?? makeModifiedFile()];
	let doneResult: unknown;
	const comp = new DiffViewComponent({
		files,
		source: "git",
		viewMode: { kind: "hunks", context: 3 },
		tui: fakeTui(120, 30),
		theme: fakeTheme(),
		keybindings: {} as any,
		done: (r) => {
			doneResult = r;
		},
		onRefresh: async () => files,
		onChangeViewMode: async () => files,
		onToggleSource: async () => undefined,
	});
	// Prime the cache so handleMouse's layout math works.
	comp.render(120);
	return { comp, getDone: () => doneResult };
}

function makeFileList(files: FileDiff[]) {
	let result: unknown;
	const comp = new FileListComponent({
		files,
		source: "git",
		viewMode: { kind: "hunks", context: 3 },
		tui: fakeTui(120, 30),
		theme: fakeTheme(),
		done: (r) => {
			result = r;
		},
	});
	comp.render(120);
	return { comp, getResult: () => result };
}

// ---------------------------------------------------------------------------
describe("DiffViewComponent.handleMouse", () => {
	test("wheel down scrolls the viewport but leaves the cursor alone", () => {
		const { comp } = makeDiffView();
		const cursorBefore = (comp as any).cursorRow as number;
		const scrollBefore = (comp as any).scrollTop as number;
		const res = comp.handleMouse(wheel(10, 3));
		assert.deepStrictEqual(res, { handled: true, render: true });
		assert.strictEqual((comp as any).cursorRow, cursorBefore, "cursor must not move on wheel");
		assert.ok((comp as any).scrollTop > scrollBefore, "scrollTop should advance");
	});

	test("wheel up reduces scrollTop without touching the cursor", () => {
		const { comp } = makeDiffView();
		(comp as any).scrollTop = 5;
		(comp as any).cursorRow = 7;
		(comp as any).invalidate();
		comp.render(120);
		comp.handleMouse(wheel(10, -2));
		assert.strictEqual((comp as any).scrollTop, 3);
		assert.strictEqual((comp as any).cursorRow, 7, "cursor stays put");
	});

	test("shift+wheel scrolls horizontally and does not move the cursor", () => {
		const { comp } = makeDiffView();
		const cursorBefore = (comp as any).cursorRow as number;
		comp.handleMouse(wheel(10, 2, /*shift=*/ true));
		assert.strictEqual((comp as any).cursorRow, cursorBefore, "cursor should not move");
		assert.ok((comp as any).scrollX > 0, "scrollX should advance");
	});

	test("left click on a body row places the cursor on it", () => {
		const { comp } = makeDiffView();
		// y=1 is the first body row (row 0 of the virtual rows after header).
		const res = comp.handleMouse(click(1));
		assert.deepStrictEqual(res, { handled: true, focus: true, render: true });
		assert.strictEqual((comp as any).cursorRow, 0);
	});

	test("clicking after wheel-scrolling re-anchors the cursor to the clicked row", () => {
		const { comp } = makeDiffView();
		// Simulate: user has an active cursor near the top, then wheels down 4
		// rows. The cursor is now off-screen; clicking at y=1 should set the
		// cursor to the visible row (scrollTop + 0).
		(comp as any).cursorRow = 2;
		(comp as any).invalidate();
		comp.render(120);
		comp.handleMouse(wheel(10, 4));
		const scrollAfterWheel = (comp as any).scrollTop as number;
		assert.strictEqual((comp as any).cursorRow, 2, "cursor still off-screen");
		comp.handleMouse(click(1));
		assert.strictEqual((comp as any).cursorRow, scrollAfterWheel, "cursor jumps to clicked row");
	});



	test("Ctrl+g accepts a source line number and jumps to its row", () => {
		const lineFile: FileDiff = {
			oldPath: "a.ts",
			newPath: "a.ts",
			displayPath: "a.ts",
			status: "modified",
			hunks: [{
				oldStart: 3,
				oldLines: 1,
				newStart: 3,
				newLines: 1,
				header: "@@ -3 +3 @@",
				lines: [{ kind: "ctx", oldLineNo: 3, newLineNo: 3, text: "line 3" }],
			}],
		};
		const { comp } = makeDiffView(lineFile);
		// Avoid the asynchronous hunk-to-full expansion; this test exercises the
		// shortcut and input flow once the whole file is available.
		(comp as any).viewMode = { kind: "full" };
		comp.handleInput("\x07"); // Ctrl+g
		assert.ok(comp.render(120).at(-1)!.includes("Go to line:"));
		comp.handleInput("3");
		assert.strictEqual((comp as any).lineJump.value, "3");
		comp.handleInput("\r");
		// file header + hunk header + source line 3
		assert.strictEqual((comp as any).cursorRow, 2);
	});

	test("l toggles the temporary left-pane hiding shortcut", () => {
		const { comp } = makeDiffView();
		assert.strictEqual((comp as any).hideLeft, false);
		comp.handleInput("l");
		assert.strictEqual((comp as any).hideLeft, true);
		assert.ok(comp.render(120)[0]!.includes("new only"), "header should expose active pane mode");
		comp.handleInput("l");
		assert.strictEqual((comp as any).hideLeft, false);
	});

	test("clicks on the header row are ignored for cursor placement", () => {
		const { comp } = makeDiffView();
		(comp as any).cursorRow = 3;
		(comp as any).invalidate();
		comp.render(120);
		comp.handleMouse(click(0));
		assert.strictEqual((comp as any).cursorRow, 3, "cursor should not change on header click");
	});
});

// ---------------------------------------------------------------------------
describe("FileListComponent.handleMouse", () => {

	test("slash lazily requests the file index, then searches and opens a match", () => {
		let result: unknown;
		const requestSearch = new FileListComponent({
			files: [], source: "git", viewMode: { kind: "hunks", context: 3 }, tui: fakeTui(), theme: fakeTheme(), done: (r) => { result = r; },
		});
		requestSearch.handleInput("/");
		assert.deepStrictEqual(result, { kind: "find-files" });

		const panel = new FileListComponent({
			files: [],
			allFiles: ["src/alpha.ts", "README.md"],
			initialSearch: true,
			source: "git",
			viewMode: { kind: "hunks", context: 3 },
			tui: fakeTui(),
			theme: fakeTheme(),
			done: (r) => { result = r; },
		});
		for (const char of "alpha") panel.handleInput(char);
		panel.handleInput("\r");
		assert.deepStrictEqual(result, { kind: "open-path", path: "src/alpha.ts" });
	});


	test("question mark streams full-text results into the search panel", async () => {
		let result: unknown;
		const panel = new FileListComponent({
			files: [], source: "git", viewMode: { kind: "hunks", context: 3 }, tui: fakeTui(), theme: fakeTheme(), done: (r) => { result = r; },
			onSearchText: (_query, onMatch, onDone) => { onMatch({ path: "src/Foo.java", lineNo: 12, text: "class Foo" }); onDone(); return () => {}; },
		});
		panel.handleInput("?");
		for (const char of "Foo") panel.handleInput(char);
		await new Promise((resolve) => setTimeout(resolve, 190));
		panel.handleInput("\r");
		assert.deepStrictEqual(result, { kind: "open-path", path: "src/Foo.java", lineNo: 12, resumeTextQuery: "Foo", resumeTextPath: "src/Foo.java", resumeTextLineNo: 12, resumeTextResults: [{ path: "src/Foo.java", lineNo: 12, text: "class Foo" }] });
	});


	test("restores the cached full-text result selection without rerunning search", () => {
		let result: unknown;
		let searches = 0;
		const results = [
			{ path: "src/First.java", lineNo: 10, text: "needle first" },
			{ path: "src/Second.java", lineNo: 20, text: "needle second" },
		];
		const comp = new FileListComponent({
			files: [], source: "git", viewMode: { kind: "hunks", context: 3 }, tui: fakeTui(), theme: fakeTheme(),
			initialTextQuery: "needle", initialTextPath: "src/Second.java", initialTextLineNo: 20, initialTextResults: results,
			done: (action) => { result = action; },
			onSearchText: () => { searches++; return () => {}; },
		});
		comp.handleInput("\r");
		assert.strictEqual(searches, 0, "cached results must not start git grep again");
		assert.deepStrictEqual(result, {
			kind: "open-path", path: "src/Second.java", lineNo: 20, resumeTextQuery: "needle",
			resumeTextPath: "src/Second.java", resumeTextLineNo: 20, resumeTextResults: results,
		});
	});

	test("wheel scrolls the list but leaves the selection cursor alone", () => {
		const { comp } = makeFileList(makeFiles(20));
		const cursorBefore = (comp as any).cursor as number;
		comp.handleMouse(wheel(10, 3));
		assert.strictEqual((comp as any).cursor, cursorBefore, "selection must not move on wheel");
		assert.strictEqual((comp as any).scrollTop, 3);
		comp.handleMouse(wheel(10, -1));
		assert.strictEqual((comp as any).scrollTop, 2);
		assert.strictEqual((comp as any).cursor, cursorBefore);
	});

	test("single click selects the file under the pointer", () => {
		const { comp } = makeFileList(makeFiles(5));
		comp.handleMouse(click(3));
		// y=3 → body row 2 → file index 2 (after header at y=0).
		assert.strictEqual((comp as any).cursor, 2);
	});

	test("clicking after wheel-scrolling re-anchors the selection to the clicked row", () => {
		const { comp } = makeFileList(makeFiles(20));
		comp.handleMouse(wheel(10, 5)); // scrollTop = 5, cursor still at 0
		assert.strictEqual((comp as any).cursor, 0);
		comp.handleMouse(click(1)); // body row 0 → file index scrollTop + 0 = 5
		assert.strictEqual((comp as any).cursor, 5);
	});



	test("retains an opened untracked file when a full-file reload only returns tracked diffs", () => {
		const tracked = makeFiles(1);
		tracked[0]!.displayPath = "AbapSourcePage.java";
		const untracked = makeModifiedFile();
		untracked.displayPath = "check-ui-deps.py";
		untracked.status = "untracked";
		const reloaded = retainFileInView(tracked, untracked);
		assert.deepStrictEqual(reloaded.map((file) => file.displayPath), ["AbapSourcePage.java", "check-ui-deps.py"]);
	});

	test("opens the selected path after an asynchronous untracked-list update", async () => {
		let result: unknown;
		const tracked = makeFiles(1);
		tracked[0]!.displayPath = "AbapSourcePage.java";
		const untracked = makeFiles(2);
		untracked[0]!.displayPath = "AbapSourcePage.java";
		untracked[1]!.displayPath = "check-ui-deps.py";
		const comp = new FileListComponent({
			files: tracked,
			source: "git",
			viewMode: { kind: "hunks", context: 3 },
			tui: fakeTui(),
			theme: fakeTheme(),
			done: (action) => { result = action; },
			onLoadUntracked: async () => untracked,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		comp.handleMouse(click(2)); // select the second, asynchronously added row
		comp.handleMouse(click(2, 2)); // open it
		assert.deepStrictEqual(result, { kind: "open-path", path: "check-ui-deps.py" });
	});

	test("double click on the selected row opens that file", () => {
		const { comp, getResult } = makeFileList(makeFiles(5));
		comp.handleMouse(click(2)); // select file index 1
		assert.strictEqual((comp as any).cursor, 1);
		comp.handleMouse(click(2, /*clickCount=*/ 2));
		assert.deepStrictEqual(getResult(), { kind: "open-path", path: "f1.ts" });
	});

	test("clicks on the header are ignored", () => {
		const { comp } = makeFileList(makeFiles(5));
		(comp as any).cursor = 3;
		(comp as any).invalidate();
		comp.render(120);
		comp.handleMouse(click(0));
		assert.strictEqual((comp as any).cursor, 3);
	});
});
