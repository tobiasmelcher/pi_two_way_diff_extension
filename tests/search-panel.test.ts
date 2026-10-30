/**
 * Tests for src/ui/SearchPanel.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SearchPanel, type SearchItem } from "../src/ui/SearchPanel.ts";

import { fakeTheme, visible } from "./helpers.ts";

function items(lines: string[]): SearchItem[] {
	return lines.map((text, i) => ({
		rowIndex: i * 2 + 1, // some non-trivial mapping
		text,
		lineNo: i + 1,
		side: i % 3 === 0 ? "+" : i % 3 === 1 ? "-" : " ",
	}));
}

describe("SearchPanel.handleInput", () => {
	test("typing filters matches live and updates the counter", () => {
		const panel = new SearchPanel(
			items(["const x = 1;", "const y = 2;", "function foo() {}"]),
			() => {},
			() => {},
		);
		assert.strictEqual(panel.matchCount, 0);

		for (const ch of "const") panel.handleInput(ch);
		assert.strictEqual(panel.queryText, "const");
		assert.strictEqual(panel.matchCount, 2);

		panel.handleInput(" ");
		panel.handleInput("y");
		assert.strictEqual(panel.matchCount, 1);
	});

	test("smart-case: lowercase query is case-insensitive", () => {
		const panel = new SearchPanel(items(["HELLO world", "hello universe"]), () => {}, () => {});
		for (const ch of "hello") panel.handleInput(ch);
		assert.strictEqual(panel.matchCount, 2);
	});

	test("smart-case: uppercase in query switches to case-sensitive", () => {
		const panel = new SearchPanel(items(["HELLO world", "hello universe"]), () => {}, () => {});
		for (const ch of "HELLO") panel.handleInput(ch);
		assert.strictEqual(panel.matchCount, 1);
	});

	test("asterisk matches any-length text without enabling other regex syntax", () => {
		const panel = new SearchPanel(
			items(["MultiPager.java", "MultiPage.java", "MultiPage.kt", "prefix MultiPageX.java suffix"]),
			() => {},
			() => {},
		);
		for (const ch of "MultiPage*.java") panel.handleInput(ch);
		assert.strictEqual(panel.matchCount, 3, "* should match zero or more characters");
	});

	test("a query containing only an asterisk matches every item", () => {
		const panel = new SearchPanel(items(["one", "two"]), () => {}, () => {});
		panel.handleInput("*");
		assert.strictEqual(panel.matchCount, 2);
	});

	test("backspace shrinks the query and re-filters", () => {
		const panel = new SearchPanel(items(["abc", "abd", "xyz"]), () => {}, () => {});
		for (const ch of "ab") panel.handleInput(ch);
		assert.strictEqual(panel.matchCount, 2);
		panel.handleInput("c");
		assert.strictEqual(panel.matchCount, 1);
		panel.handleInput("\x7f"); // backspace
		assert.strictEqual(panel.queryText, "ab");
		assert.strictEqual(panel.matchCount, 2);
	});

	test("Enter triggers onJump with the selected match's rowIndex", () => {
		let jumped = -1;
		const panel = new SearchPanel(
			items(["foo", "fobar", "baz"]),
			(idx) => {
				jumped = idx;
			},
			() => {},
		);
		for (const ch of "fo") panel.handleInput(ch);
		// Items 0 and 1 match. rowIndex of item 0 = 1 (per `items()` builder).
		panel.handleInput("\r");
		assert.strictEqual(jumped, 1);
	});

	test("Down navigates matches; Enter jumps to the selected one", () => {
		let jumped = -1;
		const panel = new SearchPanel(
			items(["foo", "fobar", "baz-foo"]),
			(idx) => {
				jumped = idx;
			},
			() => {},
		);
		for (const ch of "foo") panel.handleInput(ch);
		assert.strictEqual(panel.matchCount, 2); // "foo" and "baz-foo"
		panel.handleInput("\x1b[B"); // down
		assert.strictEqual(panel.selectedIndex, 1);
		panel.handleInput("\r");
		// Second match corresponds to item index 2 (rowIndex = 5).
		assert.strictEqual(jumped, 5);
	});

	test("Escape calls onCancel without jumping", () => {
		let cancelled = false;
		let jumped = false;
		const panel = new SearchPanel(
			items(["foo"]),
			() => {
				jumped = true;
			},
			() => {
				cancelled = true;
			},
		);
		panel.handleInput("\x1b"); // escape
		assert.strictEqual(cancelled, true);
		assert.strictEqual(jumped, false);
	});

	test("empty query produces no matches, Enter cancels gracefully", () => {
		let cancelled = false;
		const panel = new SearchPanel(items(["foo"]), () => {}, () => {
			cancelled = true;
		});
		panel.handleInput("\r"); // enter with empty query
		assert.strictEqual(cancelled, true);
	});
});

describe("SearchPanel.render", () => {
	test("renders a bordered panel with the input, matches, and hint", () => {
		const panel = new SearchPanel(items(["const x = 42;", "const y = 7;"]), () => {}, () => {});
		for (const ch of "const") panel.handleInput(ch);
		const lines = panel.render(fakeTheme(), 80);
		// Expect at least: top border, input, mid border, 1..N matches, bottom border.
		assert.ok(lines.length >= 5);
		assert.ok(visible(lines[0]!).startsWith("\u250c"), "top border");
		assert.ok(visible(lines[lines.length - 1]!).startsWith("\u2514"), "bottom border");
		// The input line shows the query and the counter.
		assert.ok(visible(lines[1]!).includes("const"));
		assert.ok(visible(lines[1]!).includes("1/2"));
		// The selected match row is prefixed with the ▶ cursor glyph.
		const matchLines = lines.slice(3, -1);
		assert.ok(matchLines.some((l) => visible(l).includes("\u25b6 ")), "selected row has ▶");
	});

	test("empty-query panel still renders a 'Type to search' hint", () => {
		const panel = new SearchPanel(items(["foo"]), () => {}, () => {});
		const lines = panel.render(fakeTheme(), 60);
		const body = lines.map(visible).join("\n");
		assert.ok(body.includes("Type to search"), body);
	});

	test("no-match panel renders 'No matches'", () => {
		const panel = new SearchPanel(items(["foo"]), () => {}, () => {});
		for (const ch of "zzz") panel.handleInput(ch);
		const lines = panel.render(fakeTheme(), 60);
		const body = lines.map(visible).join("\n");
		assert.ok(body.includes("No matches"), body);
	});
});
