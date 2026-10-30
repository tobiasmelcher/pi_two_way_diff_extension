/**
 * Tests for src/align.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { alignHunkLines, pairIntoRows } from "../src/align.ts";

describe("alignHunkLines", () => {
	test("emits ctx rows with matching line numbers on both sides", () => {
		const out = alignHunkLines(
			[
				{ marker: " ", text: "a" },
				{ marker: " ", text: "b" },
			],
			10,
			20,
		);
		assert.deepStrictEqual(out, [
			{ kind: "ctx", oldLineNo: 10, newLineNo: 20, text: "a" },
			{ kind: "ctx", oldLineNo: 11, newLineNo: 21, text: "b" },
		]);
	});

	test("pairs one del and one add 1:1", () => {
		const out = alignHunkLines(
			[
				{ marker: "-", text: "old" },
				{ marker: "+", text: "new" },
			],
			5,
			5,
		);
		assert.deepStrictEqual(out, [
			{ kind: "del", oldLineNo: 5, text: "old" },
			{ kind: "add", newLineNo: 5, text: "new" },
		]);
	});

	test("pads the right pane for leftover -", () => {
		const out = alignHunkLines(
			[
				{ marker: "-", text: "a" },
				{ marker: "-", text: "b" },
				{ marker: "+", text: "A" },
			],
			1,
			1,
		);
		assert.deepStrictEqual(out, [
			{ kind: "del", oldLineNo: 1, text: "a" },
			{ kind: "add", newLineNo: 1, text: "A" },
			{ kind: "del", oldLineNo: 2, text: "b" },
			{ kind: "pad", text: "" },
		]);
	});

	test("pads the left pane for leftover +", () => {
		const out = alignHunkLines(
			[
				{ marker: "-", text: "x" },
				{ marker: "+", text: "X" },
				{ marker: "+", text: "Y" },
			],
			1,
			1,
		);
		assert.deepStrictEqual(out, [
			{ kind: "del", oldLineNo: 1, text: "x" },
			{ kind: "add", newLineNo: 1, text: "X" },
			{ kind: "pad", text: "" },
			{ kind: "add", newLineNo: 2, text: "Y" },
		]);
	});

	test("increments line numbers correctly across mixed runs", () => {
		const out = alignHunkLines(
			[
				{ marker: " ", text: "c1" },
				{ marker: "-", text: "d" },
				{ marker: "+", text: "A" },
				{ marker: " ", text: "c2" },
			],
			100,
			200,
		);
		assert.deepStrictEqual(out, [
			{ kind: "ctx", oldLineNo: 100, newLineNo: 200, text: "c1" },
			{ kind: "del", oldLineNo: 101, text: "d" },
			{ kind: "add", newLineNo: 201, text: "A" },
			{ kind: "ctx", oldLineNo: 102, newLineNo: 202, text: "c2" },
		]);
	});
});

describe("pairIntoRows", () => {
	test("ctx becomes (ctx, ctx) on both sides", () => {
		const rows = pairIntoRows([{ kind: "ctx", oldLineNo: 1, newLineNo: 1, text: "x" }]);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.left.kind, "ctx");
		assert.strictEqual(rows[0]!.right.kind, "ctx");
	});

	test("del+add become one aligned row with (del, add)", () => {
		const rows = pairIntoRows([
			{ kind: "del", oldLineNo: 1, text: "a" },
			{ kind: "add", newLineNo: 1, text: "A" },
		]);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.left.kind, "del");
		assert.strictEqual(rows[0]!.right.kind, "add");
	});

	test("del followed by pad is one row with pad on the right", () => {
		const rows = pairIntoRows([
			{ kind: "del", oldLineNo: 2, text: "b" },
			{ kind: "pad", text: "" },
		]);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.right.kind, "pad");
	});

	test("pad+add is one row with pad on the left", () => {
		const rows = pairIntoRows([
			{ kind: "pad", text: "" },
			{ kind: "add", newLineNo: 3, text: "C" },
		]);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0]!.left.kind, "pad");
		assert.strictEqual(rows[0]!.right.kind, "add");
	});
});
