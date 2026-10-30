/**
 * Shared helpers for the test suite.
 *
 * - `fakeTheme()` returns a passthrough Theme (no decoration), so that
 *   `visibleWidth` from pi-tui and our renderer agree on column counts in
 *   tests. For style-presence assertions, test against the raw ANSI escapes
 *   that components emit directly.
 * - `fakeTui(cols, rows)` returns a TUI stub with just the surface the diff
 *   components touch.
 * - `visible(s)` strips ANSI escapes for plain-text matching.
 */

export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function visible(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** Pass-through Theme stand-in. */
export function fakeTheme(): any {
	const id = (s: string) => s;
	return {
		fg: (_tok: string, s: string) => s,
		bg: (_tok: string, s: string) => s,
		bold: id,
		italic: id,
		underline: id,
		inverse: id,
		strikethrough: id,
		style: (s: string, _o: any) => s,
	};
}

/** Minimal TUI stand-in. */
export function fakeTui(cols = 120, rows = 30): any {
	return {
		terminal: { columns: cols, rows },
		requestRender: () => {},
	};
}
