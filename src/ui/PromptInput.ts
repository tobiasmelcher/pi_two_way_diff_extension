/**
 * A tiny single-line input used by the diff view's "p" (prompt) action.
 *
 * Lives inside the DiffViewComponent's render; the component delegates key
 * input to this when active and swaps the footer hint. We implement Focusable
 * so the hardware cursor marker is emitted correctly (IME support).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Focusable, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export class PromptInput implements Focusable {
	focused = true;
	private buffer = "";
	private cursor = 0;
	private readonly label: string;
	private readonly onSubmit: (text: string) => void;
	private readonly onCancel: () => void;

	constructor(label: string, onSubmit: (text: string) => void, onCancel: () => void) {
		this.label = label;
		this.onSubmit = onSubmit;
		this.onCancel = onCancel;
	}

	/** Returns true if the key was handled. */
	handleInput(data: string): boolean {
		if (matchesKey(data, "escape")) {
			this.onCancel();
			return true;
		}
		if (matchesKey(data, "return")) {
			this.onSubmit(this.buffer.trim());
			return true;
		}
		if (matchesKey(data, "backspace")) {
			if (this.cursor > 0) {
				this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
				this.cursor--;
			}
			return true;
		}
		if (matchesKey(data, "left")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return true;
		}
		if (matchesKey(data, "right")) {
			this.cursor = Math.min(this.buffer.length, this.cursor + 1);
			return true;
		}
		if (matchesKey(data, "home")) {
			this.cursor = 0;
			return true;
		}
		if (matchesKey(data, "end")) {
			this.cursor = this.buffer.length;
			return true;
		}
		// Insert printable chars (keep it simple: single bytes >= 32, not a
		// control sequence).
		if (data.length === 1) {
			const code = data.charCodeAt(0);
			if (code >= 32 && code !== 127) {
				this.buffer = this.buffer.slice(0, this.cursor) + data + this.buffer.slice(this.cursor);
				this.cursor++;
				return true;
			}
		} else if (!data.startsWith("\x1b")) {
			// multi-byte UTF-8 input
			this.buffer = this.buffer.slice(0, this.cursor) + data + this.buffer.slice(this.cursor);
			this.cursor += data.length;
			return true;
		}
		return false;
	}

	render(theme: Theme, width: number): string {
		const prefix = theme.fg("accent", `${this.label} `);
		const prefixW = visibleWidth(prefix);
		const roomForBody = Math.max(1, width - prefixW);
		const before = this.buffer.slice(0, this.cursor);
		const after = this.buffer.slice(this.cursor);
		const cursorChar = after[0] ?? " ";
		const afterTail = after.slice(1);
		const marker = this.focused ? CURSOR_MARKER : "";
		const body = `${before}${marker}${renderFakeCursor(cursorChar)}${afterTail}`;
		const bodyTrunc = truncateToWidth(body, roomForBody);
		return `${prefix}${bodyTrunc}`;
	}

	get value(): string {
		return this.buffer;
	}
}
