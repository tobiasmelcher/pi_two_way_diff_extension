/**
 * Tests for src/render.ts.
 *
 * We assert against the semantic output of the fake theme (`<INV>…`, etc.)
 * so we can check for both the color-blind-safe markers (▶ / █) and the
 * stacked style attributes without parsing raw ANSI.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildVirtualRows, highlightJava, renderDiffViewport, shouldUseSideBySide } from "../src/render.ts";
import type { FileDiff } from "../src/types.ts";

import { fakeTheme, visible } from "./helpers.ts";

function makeModifiedFile(): FileDiff {
	return {
		oldPath: "a.ts",
		newPath: "a.ts",
		displayPath: "a.ts",
		status: "modified",
		hunks: [
			{
				oldStart: 1,
				oldLines: 2,
				newStart: 1,
				newLines: 2,
				header: "@@ -1,2 +1,2 @@",
				lines: [
					{ kind: "ctx", oldLineNo: 1, newLineNo: 1, text: "a" },
					{ kind: "del", oldLineNo: 2, text: "x" },
					{ kind: "add", newLineNo: 2, text: "y" },
				],
			},
		],
	};
}


describe("highlightJava", () => {
	test("colors Java keywords, strings, annotations, and comments without parsing regex", () => {
		const theme: any = { ...fakeTheme(), fg: (token: string, text: string) => `<${token}>${text}</${token}>` };
		const colored = highlightJava('@Override public String name() { return "value"; // note', theme);
		assert.ok(colored.includes("<warning>@Override</warning>"));
		assert.ok(colored.includes("<accent>public</accent>"));
		assert.ok(colored.includes("<accent>return</accent>"));
		assert.ok(colored.includes("<success>\"value\"</success>"));
		assert.ok(colored.includes("<dim>// note</dim>"));
	});
});



	test("keeps Java add and delete rows in their diff colors", () => {
		const theme: any = { ...fakeTheme(), fg: (token: string, text: string) => `<${token}>${text}</${token}>` };
		const rows = buildVirtualRows({
			oldPath: "A.java", newPath: "A.java", displayPath: "A.java", status: "modified",
			hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "@@", lines: [
				{ kind: "del", oldLineNo: 1, text: "// removed" },
				{ kind: "add", newLineNo: 1, text: "// added" },
			] }],
		});
		const lines = renderDiffViewport({ theme, width: 1000, bodyHeight: 4, rows, scrollTop: 0, cursorRow: -1, sideBySide: true, language: "java" });
		assert.ok(lines[2]!.includes("<toolDiffRemoved>// removed"));
		assert.ok(lines[2]!.includes("<toolDiffAdded>// added"));
		assert.ok(!lines[2]!.includes("<dim>// removed"));
	});

describe("buildVirtualRows", () => {
	test("emits fileHeader + hunkHeader + one diff row per aligned pair", () => {
		const file = makeModifiedFile();
		const rows = buildVirtualRows(file);
		assert.strictEqual(rows[0]!.kind, "fileHeader");
		assert.strictEqual(rows[1]!.kind, "hunkHeader");
		// After pairing we have: ctx row + (del,add) row = 2 diff rows.
		assert.strictEqual(rows[2]!.kind, "diff");
		assert.strictEqual(rows[3]!.kind, "diff");
	});

	test("empty-hunks file shows a 'No changes' note", () => {
		const rows = buildVirtualRows({
			oldPath: "a",
			newPath: "a",
			displayPath: "a",
			status: "modified",
			hunks: [],
		});
		assert.strictEqual(rows[1]!.kind, "note");
	});

	test("binary file shows a 'Binary file' note", () => {
		const rows = buildVirtualRows({
			oldPath: "a",
			newPath: "a",
			displayPath: "a",
			status: "modified",
			hunks: [],
			binary: true,
		});
		assert.strictEqual(rows[1]!.kind, "note");
	});
});

describe("shouldUseSideBySide", () => {
	test("true for wide terminals, false for narrow", () => {
		assert.strictEqual(shouldUseSideBySide(100), true);
		assert.strictEqual(shouldUseSideBySide(120), true);
		assert.strictEqual(shouldUseSideBySide(99), false);
		assert.strictEqual(shouldUseSideBySide(40), false);
	});
});

describe("renderDiffViewport", () => {
	test("returns exactly bodyHeight lines, each of visible width `width`", () => {
		const theme = fakeTheme();
		const rows = buildVirtualRows(makeModifiedFile());
		const lines = renderDiffViewport({
			theme,
			width: 120,
			bodyHeight: 10,
			rows,
			scrollTop: 0,
			cursorRow: -1,
			sideBySide: true,
		});
		assert.strictEqual(lines.length, 10);
		for (const l of lines) {
			assert.strictEqual(visible(l).length, 120, `line out of bounds: ${JSON.stringify(l)}`);
		}
	});

	test("cursor row carries the triple-coded indicator (▶ + inverse + bold)", () => {
		const theme = fakeTheme();
		const rows = buildVirtualRows(makeModifiedFile());
		const lines = renderDiffViewport({
			theme,
			width: 120,
			bodyHeight: 10,
			rows,
			scrollTop: 0,
			cursorRow: 2,
			sideBySide: true,
		});
		const cursorLine = lines[2]!;
		// Visible marker glyph.
		assert.ok(visible(cursorLine).includes("\u25b6"), "cursor glyph '▶' missing");
		// Inverse+bold wrappers are applied by applyRowHighlight directly as
		// raw ANSI (not via theme.style), to survive truncation.
		assert.ok(cursorLine.startsWith("\x1b[7m\x1b[1m"), `missing opens, got: ${JSON.stringify(cursorLine.slice(0, 30))}`);
		assert.ok(cursorLine.endsWith("\x1b[22m\x1b[27m"), `missing closes, got: ${JSON.stringify(cursorLine.slice(-30))}`);
	});

	test("selection rows get underline + bold + the █ glyph", () => {
		const theme = fakeTheme();
		const rows = buildVirtualRows(makeModifiedFile());
		const lines = renderDiffViewport({
			theme,
			width: 120,
			bodyHeight: 10,
			rows,
			scrollTop: 0,
			cursorRow: -1,
			selection: { fromRow: 2, toRow: 3 },
			sideBySide: true,
		});
		for (const idx of [2, 3]) {
			const l = lines[idx]!;
			assert.ok(visible(l).includes("\u2588"), `row ${idx} missing '█' glyph`);
			assert.ok(l.startsWith("\x1b[4m\x1b[1m"), `row ${idx} missing underline/bold opens`);
		}
	});


	test("hiding the left pane gives the new/source pane the full row width", () => {
		const theme = fakeTheme();
		const rows = buildVirtualRows(makeModifiedFile());
		const lines = renderDiffViewport({
			theme,
			width: 120,
			bodyHeight: 4,
			rows,
			scrollTop: 0,
			cursorRow: -1,
			sideBySide: true,
			hideLeft: true,
		});
		const changedLine = visible(lines[3]!);
		assert.ok(changedLine.includes("+ y"), "new/source line should remain visible");
		assert.ok(!changedLine.includes("- x"), "old line should be hidden");
		assert.ok(!changedLine.includes("│"), "two-pane divider should be removed");
		assert.strictEqual(changedLine.length, 120);
	});

	test("horizontal scroll reveals content past the right edge", () => {
		const theme = fakeTheme();
		const longText = "a".repeat(50) + "SECRET" + "b".repeat(50);
		const rows = buildVirtualRows({
			oldPath: "f",
			newPath: "f",
			displayPath: "f",
			status: "modified",
			hunks: [
				{
					oldStart: 1,
					oldLines: 1,
					newStart: 1,
					newLines: 1,
					header: "@@",
					lines: [{ kind: "add", newLineNo: 1, text: longText }],
				},
			],
		});

		// At scrollX=0, SECRET sits around column 50 — pane is only ~56 cols
		// (width 120 - marker 2 - divider 1 = 117 / 2 ≈ 58, minus gutter 8 ≈
		// 50). It should NOT be visible.
		const atZero = renderDiffViewport({
			theme,
			width: 120,
			bodyHeight: 3,
			rows,
			scrollTop: 0,
			cursorRow: -1,
			sideBySide: true,
			scrollX: 0,
		});
		assert.ok(!visible(atZero.join("")).includes("SECRET"), "SECRET should not be visible at scrollX=0");

		// At scrollX=40 it slides into view.
		const atScrolled = renderDiffViewport({
			theme,
			width: 120,
			bodyHeight: 3,
			rows,
			scrollTop: 0,
			cursorRow: -1,
			sideBySide: true,
			scrollX: 40,
		});
		assert.ok(
			visible(atScrolled.join("")).includes("SECRET"),
			"SECRET should be visible after horizontal scroll",
		);
	});
});

describe("regression: long-line truncation does not drop row highlight", () => {
	test("cursor row stays highlighted after an embedded ANSI reset", () => {
		// We use a real-ANSI-emitting theme here (not the fake tag theme) so
		// we can specifically assert on the pattern that caused the bug: an
		// embedded `\x1b[0m` from truncateToWidth must be followed by a
		// re-opened inverse+bold.
		const realTheme: any = {
			fg: (_t: string, s: string) => `\x1b[36m${s}\x1b[39m`,
			bg: (_t: string, s: string) => s,
			bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
			italic: (s: string) => s,
			underline: (s: string) => s,
			inverse: (s: string) => s,
			strikethrough: (s: string) => s,
			style: (_s: string, _o: any) => {
				throw new Error("style() should not be called by applyRowHighlight anymore");
			},
		};
		const text = "a".repeat(500);
		const rows = buildVirtualRows({
			oldPath: "f",
			newPath: "f",
			displayPath: "f",
			status: "modified",
			hunks: [
				{
					oldStart: 1,
					oldLines: 1,
					newStart: 1,
					newLines: 1,
					header: "@@",
					lines: [{ kind: "add", newLineNo: 1, text }],
				},
			],
		});
		const lines = renderDiffViewport({
			theme: realTheme,
			width: 120,
			bodyHeight: 3,
			rows,
			scrollTop: 0,
			cursorRow: 2,
			sideBySide: true,
			scrollX: 0,
		});
		const row = lines[2]!;
		const invOn = (row.match(/\x1b\[7m/g) ?? []).length;
		const invOff = (row.match(/\x1b\[27m/g) ?? []).length;
		const fullReset = (row.match(/\x1b\[0m/g) ?? []).length;
		// Every embedded full-reset must be followed by one more inverse-on.
		assert.ok(invOn >= 1 + fullReset, `inverse-on=${invOn} fullReset=${fullReset}`);
		// And exactly one clean close at the end.
		assert.strictEqual(invOff, 1, `inverse-off should be 1, got ${invOff}`);
	});
});
