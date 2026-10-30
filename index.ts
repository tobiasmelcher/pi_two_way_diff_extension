/**
 * /diff command — a file-list → two-way diff flow for all open changes in
 * the current working directory, with navigation and line-based prompting.
 *
 * See PLAN.md for the full design and README.md for keybindings.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { collectGitDiffs, listWorkingTreeFiles, loadWorkingTreeFile, NotAGitRepoError, searchGitText } from "./src/git.ts";
import type { DiffSource, FileDiff, ViewMode } from "./src/types.ts";
import { DiffViewComponent, type DiffViewResult } from "./src/ui/DiffViewComponent.ts";
import { FileListComponent, type FileListAction, type TextSearchResult } from "./src/ui/FileListComponent.ts";

const FULL_FILE_CONTEXT = 1_000_000;
const CONTEXT_LADDER = [0, 1, 2, 3, 5, 8, 12, 20];

export default function (pi: ExtensionAPI) {
	pi.registerCommand("diff", {
		description: "Show a two-way diff of open changes with navigation and line-based prompting",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/diff requires interactive mode", "error");
				return;
			}
			await runDiffFlow(pi, ctx);
		},
	});
}

async function runDiffFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	let source: DiffSource = "git";
	let viewMode: ViewMode = { kind: "hunks", context: 3 };
	let files: FileDiff[];
	// Building the full file-search index is deferred until `/` is pressed.
	let allFiles: string[] | undefined;
	let openFileSearch = false;
	let resumeTextQuery: string | undefined;
	let resumeTextPath: string | undefined;
	let resumeTextLineNo: number | undefined;
	let resumeTextResults: TextSearchResult[] | undefined;
	let untrackedLoaded = false;
	try {
		files = await loadForMode(ctx.cwd, source, viewMode, false);
	} catch (err) {
		if (err instanceof NotAGitRepoError) {
			ctx.ui.notify(`Not a git repository: ${ctx.cwd}`, "error");
		} else {
			ctx.ui.notify(`Failed to compute diff: ${(err as Error).message}`, "error");
		}
		return;
	}

	let cursorFile = 0;

	// Main loop: show list → open file → maybe back to list → ...
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const listResult = await showFileList(
			ctx, files, allFiles ?? [], source, viewMode, cursorFile, openFileSearch, resumeTextQuery, resumeTextPath, resumeTextLineNo, resumeTextResults,
			untrackedLoaded ? undefined : async () => {
				files = await loadForMode(ctx.cwd, source, viewMode, true);
				untrackedLoaded = true;
				return files;
			},
		);
		openFileSearch = false;
		resumeTextQuery = undefined;
		resumeTextPath = undefined;
		resumeTextLineNo = undefined;
		resumeTextResults = undefined;
		if (listResult.kind === "quit") return;

		if (listResult.kind === "find-files") {
			try {
				allFiles ??= await listWorkingTreeFiles(ctx.cwd);
				openFileSearch = true;
			} catch (err) {
				ctx.ui.notify(`File search index failed: ${(err as Error).message}`, "error");
			}
			continue;
		}

		if (listResult.kind === "refresh") {
			try {
				files = await loadForMode(ctx.cwd, source, viewMode, false);
				untrackedLoaded = false;
				if (allFiles) allFiles = await listWorkingTreeFiles(ctx.cwd);
			} catch (err) {
				ctx.ui.notify(`Refresh failed: ${(err as Error).message}`, "error");
			}
			cursorFile = Math.min(cursorFile, Math.max(0, files.length - 1));
			continue;
		}

		if (listResult.kind === "toggle-full") {
			viewMode = viewMode.kind === "full" ? { kind: "hunks", context: 3 } : { kind: "full" };
			files = await safeLoad(ctx, source, viewMode, files);
			cursorFile = Math.min(cursorFile, Math.max(0, files.length - 1));
			continue;
		}
		if (listResult.kind === "toggle-source") {
			if (source === "git") {
				ctx.ui.notify("Session source not yet available", "info");
			} else {
				source = "git";
				files = await safeLoad(ctx, source, viewMode, files);
				cursorFile = 0;
			}
			continue;
		}
		if (listResult.kind === "context-change") {
			if (viewMode.kind !== "hunks") {
				ctx.ui.notify("Switch to hunks view first (press f)", "info");
				continue;
			}
			const idx = CONTEXT_LADDER.indexOf(viewMode.context);
			const nextIdx = clamp((idx >= 0 ? idx : 3) + listResult.delta, 0, CONTEXT_LADDER.length - 1);
			const nextCtx = CONTEXT_LADDER[nextIdx]!;
			if (nextCtx === viewMode.context) continue;
			viewMode = { kind: "hunks", context: nextCtx };
			files = await safeLoad(ctx, source, viewMode, files);
			cursorFile = Math.min(cursorFile, Math.max(0, files.length - 1));
			continue;
		}

		// Open either a changed-file list entry or a file chosen via `/` search.
		let selectedCleanPath: string | undefined;
		let retainedFile: FileDiff | undefined;
		let restoreViewMode: ViewMode | undefined;
		const requestedPath = listResult.path;
		if (listResult.lineNo !== undefined && viewMode.kind !== "full") {
			restoreViewMode = viewMode;
			viewMode = { kind: "full" };
			files = await loadForMode(ctx.cwd, source, viewMode, false);
		}
		const existing = files.findIndex((file) => file.displayPath === requestedPath);
		if (existing >= 0) {
			cursorFile = existing;
		} else {
			const selected = await loadWorkingTreeFile(ctx.cwd, requestedPath);
			if (!selected) {
				ctx.ui.notify(`Could not open file: ${requestedPath}`, "error");
				continue;
			}
			files = [...files, selected];
			selectedCleanPath = requestedPath;
			cursorFile = files.length - 1;
		}
		if (files[cursorFile]?.status === "untracked" || files[cursorFile]?.status === "clean") {
			retainedFile = files[cursorFile];
		}
		const addSelectedCleanFile = async (loaded: FileDiff[]): Promise<FileDiff[]> => {
			if (retainedFile) return retainFileInView(loaded, retainedFile);
			if (!selectedCleanPath) return loaded;
			const selected = await loadWorkingTreeFile(ctx.cwd, selectedCleanPath);
			return selected ? [...loaded, selected] : loaded;
		};
		const diffResult = await showDiffView(ctx, files, source, viewMode, cursorFile, listResult.kind === "open-path" ? listResult.lineNo : undefined, async (newMode) => {
			viewMode = newMode;
			files = await loadForMode(ctx.cwd, source, viewMode);
			return await addSelectedCleanFile(files);
		}, async (newSource) => {
			if (newSource === "session") return undefined;
			source = newSource;
			files = await loadForMode(ctx.cwd, source, viewMode);
			return await addSelectedCleanFile(files);
		}, async () => {
			files = await loadForMode(ctx.cwd, source, viewMode);
			return await addSelectedCleanFile(files);
		});

		if (!diffResult || diffResult.kind === "quit") return;
		if (diffResult.kind === "back") {
			cursorFile = diffResult.fileIndex ?? cursorFile;
			if (restoreViewMode) {
				viewMode = restoreViewMode;
				files = await safeLoad(ctx, source, viewMode, files);
			}
			if (listResult.kind === "open-path") {
				resumeTextQuery = listResult.resumeTextQuery;
				resumeTextPath = listResult.resumeTextPath;
				resumeTextLineNo = listResult.resumeTextLineNo;
				resumeTextResults = listResult.resumeTextResults;
			}
			continue;
		}
		if (diffResult.kind === "prompt" && diffResult.promptText) {
			const body = diffResult.snippet
				? `${diffResult.snippet}\n\n${diffResult.promptText}`
				: diffResult.promptText;
			if (!ctx.isIdle()) {
				pi.sendUserMessage(body, { deliverAs: "followUp" });
				ctx.ui.notify("Message queued (agent is busy)", "info");
			} else {
				pi.sendUserMessage(body);
			}
			return;
		}
	}
}

async function showFileList(
	ctx: ExtensionCommandContext,
	files: FileDiff[],
	allFiles: string[],
	source: DiffSource,
	viewMode: ViewMode,
	initialIndex: number,
	initialSearch: boolean,
	initialTextQuery: string | undefined,
	initialTextPath: string | undefined,
	initialTextLineNo: number | undefined,
	initialTextResults: TextSearchResult[] | undefined,
	onLoadUntracked?: () => Promise<FileDiff[]>,
): Promise<FileListAction> {
	return await ctx.ui.custom<FileListAction>(
		(tui, theme, _kb, done) =>
			new FileListComponent({ files, allFiles, source, viewMode, tui, theme, done, initialIndex, initialSearch, initialTextQuery, initialTextPath, initialTextLineNo, initialTextResults, onLoadUntracked, onSearchText: (query, onMatch, onDone) => searchGitText(ctx.cwd, query, onMatch, onDone) }),
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
	);
}

async function showDiffView(
	ctx: ExtensionCommandContext,
	files: FileDiff[],
	source: DiffSource,
	viewMode: ViewMode,
	initialFileIndex: number,
	initialLineNo: number | undefined,
	onChangeViewMode: (m: ViewMode) => Promise<FileDiff[]>,
	onToggleSource: (s: DiffSource) => Promise<FileDiff[] | undefined>,
	onRefresh: () => Promise<FileDiff[]>,
): Promise<DiffViewResult | undefined> {
	return await ctx.ui.custom<DiffViewResult | undefined>(
		(tui, theme, keybindings, done) =>
			new DiffViewComponent({
				files,
				source,
				viewMode,
				initialFileIndex,
				initialLineNo,
				tui,
				theme,
				keybindings,
				done,
				onRefresh,
				onChangeViewMode,
				onToggleSource,
			}),
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
	);
}

async function safeLoad(
	ctx: ExtensionCommandContext,
	source: DiffSource,
	viewMode: ViewMode,
	fallback: FileDiff[],
): Promise<FileDiff[]> {
	try {
		return await loadForMode(ctx.cwd, source, viewMode);
	} catch (err) {
		ctx.ui.notify(`Load failed: ${(err as Error).message}`, "error");
		return fallback;
	}
}

async function loadForMode(cwd: string, source: DiffSource, mode: ViewMode, includeUntracked = false): Promise<FileDiff[]> {
	if (source === "git") {
		const context = mode.kind === "full" ? FULL_FILE_CONTEXT : mode.context;
		return collectGitDiffs({ cwd, context, includeUntracked });
	}
	return [];
}

/** Keep an opened untracked/clean file available across a mode reload. */
export function retainFileInView(files: FileDiff[], retained: FileDiff): FileDiff[] {
	return files.some((file) => file.displayPath === retained.displayPath) ? files : [...files, retained];
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}
