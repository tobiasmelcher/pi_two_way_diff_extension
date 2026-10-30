/**
 * Tests for the unified-diff parser in src/git.ts.
 *
 * We only test the pure `parseUnifiedDiff()` function here — not the git
 * exec path — so these run offline and deterministically.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseUnifiedDiff } from "../src/git.ts";

const MODIFIED_DIFF = `diff --git a/foo.ts b/foo.ts
index 123..456 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 42;
 const c = 3;
`;

const ADDED_DIFF = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0..abc
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+hello
+world
`;

const DELETED_DIFF = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index abc..0
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-cruel
`;

const RENAMED_DIFF = `diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -5,1 +5,1 @@
-x
+y
`;

const BINARY_DIFF = `diff --git a/img.png b/img.png
index abc..def 100644
Binary files a/img.png and b/img.png differ
`;

const MULTI_FILE_DIFF = MODIFIED_DIFF + ADDED_DIFF;

describe("parseUnifiedDiff", () => {
	test("returns an empty array for empty input", () => {
		assert.deepStrictEqual(parseUnifiedDiff(""), []);
	});

	test("parses a modified file with one hunk", () => {
		const files = parseUnifiedDiff(MODIFIED_DIFF);
		assert.strictEqual(files.length, 1);
		const f = files[0]!;
		assert.strictEqual(f.status, "modified");
		assert.strictEqual(f.displayPath, "foo.ts");
		assert.strictEqual(f.oldPath, "foo.ts");
		assert.strictEqual(f.newPath, "foo.ts");
		assert.strictEqual(f.hunks.length, 1);
		const h = f.hunks[0]!;
		assert.strictEqual(h.oldStart, 1);
		assert.strictEqual(h.oldLines, 3);
		assert.strictEqual(h.newStart, 1);
		assert.strictEqual(h.newLines, 3);
	});

	test("detects added files via `new file mode`", () => {
		const files = parseUnifiedDiff(ADDED_DIFF);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0]!.status, "added");
		assert.strictEqual(files[0]!.oldPath, "/dev/null");
		assert.strictEqual(files[0]!.newPath, "new.ts");
	});

	test("detects deleted files via `deleted file mode`", () => {
		const files = parseUnifiedDiff(DELETED_DIFF);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0]!.status, "deleted");
		assert.strictEqual(files[0]!.newPath, "/dev/null");
		assert.strictEqual(files[0]!.oldPath, "old.ts");
		assert.strictEqual(files[0]!.displayPath, "old.ts");
	});

	test("detects renames via `rename from` / `rename to`", () => {
		const files = parseUnifiedDiff(RENAMED_DIFF);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0]!.status, "renamed");
	});

	test("marks binary files", () => {
		const files = parseUnifiedDiff(BINARY_DIFF);
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0]!.binary, true);
		assert.strictEqual(files[0]!.hunks.length, 0);
	});

	test("parses multiple files in one diff output", () => {
		const files = parseUnifiedDiff(MULTI_FILE_DIFF);
		assert.strictEqual(files.length, 2);
		assert.strictEqual(files[0]!.displayPath, "foo.ts");
		assert.strictEqual(files[1]!.displayPath, "new.ts");
	});

	test("ignores `\\ No newline at end of file` markers", () => {
		const diff = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
		const files = parseUnifiedDiff(diff);
		assert.strictEqual(files.length, 1);
		// Expect exactly one del + one add aligned into one row (del, add).
		const lines = files[0]!.hunks[0]!.lines;
		assert.strictEqual(lines.length, 2);
		assert.strictEqual(lines[0]!.kind, "del");
		assert.strictEqual(lines[1]!.kind, "add");
	});

	test("handles hunk headers without explicit line counts (defaults to 1)", () => {
		const diff = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -5 +5 @@
-x
+y
`;
		const files = parseUnifiedDiff(diff);
		const h = files[0]!.hunks[0]!;
		assert.strictEqual(h.oldStart, 5);
		assert.strictEqual(h.oldLines, 1);
		assert.strictEqual(h.newStart, 5);
		assert.strictEqual(h.newLines, 1);
	});
});
