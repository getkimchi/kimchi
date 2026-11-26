import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommandContext, sendTerminalInput } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { withPrintGate } from "../print-mode.js"
import { resolveReviewPanel } from "../review-panel/lenses.js"
import type { ResolvedReviewTarget } from "../review-targets/types.js"
import { ReviewTargetError } from "../review-targets/types.js"
import { activeReviewForTest } from "./active-runs.js"
import type { ReviewCommandDependencies } from "./command.js"
import { runReviewCommand } from "./command.js"

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function target(checkoutPath = "/private/review/lifecycle-checkout"): ResolvedReviewTarget {
	return {
		scope: {
			kind: "working-tree",
			refs: { resolvedBase: "HEAD", head: "working-tree" },
			includeWorkingTree: true,
			baseSource: "head",
			pinned: { baseSha: "a".repeat(40), headSha: "b".repeat(40), tipSha: "b".repeat(40) },
			headKind: "working-tree-snapshot",
			dirty: true,
			files: { changed: 1, anchorable: 1, unanchorable: 0 },
			anchorSource: "local",
			checkoutPath,
			contextDir: "/private/review/context",
			commentableLinesPath: "/private/review/context/commentable-lines.json",
			limitations: [],
		},
		cleanup: vi.fn(async () => {}),
	}
}

function dependencies(
	runPanel: ReviewCommandDependencies["runPanel"],
	checkoutPath?: string,
): Partial<ReviewCommandDependencies> {
	return {
		resolveTarget: vi.fn(async () => target(checkoutPath)),
		resolvePanel: resolveReviewPanel,
		runPanel,
		cleanSnapshots: vi.fn(async () => []),
		recoverWorktrees: vi.fn(async () => []),
		readSettings: vi.fn(() => ({ requiredLenses: [], checkDefinitions: [] })),
	}
}

function context() {
	const root = mkdtempSync(join(tmpdir(), "review-command-lifecycle-"))
	temporaryDirectories.push(root)
	const ctx = createCommandContext()
	ctx.cwd = root
	return ctx
}

type DialogOptions = Parameters<ExtensionCommandContext["ui"]["select"]>[2]

function cancelledDialog(options: DialogOptions): Promise<string | undefined> {
	const signal = options?.signal
	if (!signal) throw new Error("The interaction did not receive the operation signal")
	return new Promise<string | undefined>((resolve) => {
		const cancelled = () => resolve(undefined)
		if (signal.aborted) cancelled()
		else signal.addEventListener("abort", cancelled, { once: true })
	})
}

async function assertPromptEscapeSettles(kind: "divergence" | "confirmation" | "input"): Promise<void> {
	const ctx = context()
	const { api } = createExtensionApi()
	const deps = dependencies(vi.fn())
	if (kind === "input") {
		vi.spyOn(ctx.ui, "select").mockImplementation((_title, options) => {
			const choice = options.find((option) => option === "Choose another base" || option === "Enter another base")
			return Promise.resolve(choice)
		})
	}
	if (kind === "input") {
		vi.spyOn(ctx.ui, "input").mockImplementation((_title, _placeholder, options) => cancelledDialog(options))
	} else {
		vi.spyOn(ctx.ui, "select").mockImplementation((_title, _options, options) => cancelledDialog(options))
	}
	deps.resolveTarget = vi.fn(async (_request, options) => {
		if (kind === "divergence") {
			await options.interactions?.chooseBranchRevision({
				branch: "feature",
				remote: "origin",
				local: {
					ref: "refs/heads/feature",
					sha: "a".repeat(40),
					ahead: 1,
					behind: 1,
				},
				remoteRevision: { ref: "refs/remotes/origin/feature", sha: "b".repeat(40) },
			})
		} else {
			await options.interactions?.chooseBase({
				branch: "feature",
				candidates: [{ ref: "main", source: "local" }],
			})
		}
		return target(ctx.cwd)
	})
	const pending = runReviewCommand("branch feature", ctx, api, { dependencies: deps })
	const dialog = kind === "input" ? ctx.ui.input : ctx.ui.select
	await vi.waitFor(() => expect(dialog).toHaveBeenCalledTimes(1))
	sendTerminalInput(ctx, "\u001b")
	await pending
	expect(deps.runPanel).not.toHaveBeenCalled()
	expect(ctx.ui.notify).toHaveBeenCalledWith("Review failed: Review interrupted by the user.", "error")
	expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("review-panel", undefined, { placement: "aboveEditor" })
	expect(activeReviewForTest(ctx.sessionManager.getSessionId())).toBeUndefined()
}

describe("review command widget lifecycle", () => {
	it("clears the widget after a thrown panel failure", async () => {
		const ctx = context()
		const { api } = createExtensionApi()
		const runPanel = vi.fn(async () => {
			throw new Error("panel exploded")
		}) as ReviewCommandDependencies["runPanel"]
		await runReviewCommand("working-tree --lens spec", ctx, api, {
			dependencies: dependencies(runPanel, ctx.cwd),
		})
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("review-panel", undefined, { placement: "aboveEditor" })
		expect(ctx.ui.notify).toHaveBeenCalledWith("Review failed: panel exploded", "error")
	})

	it("cleans resolved provider resources when the deferred stale sweep fails", async () => {
		const ctx = context()
		const { api } = createExtensionApi()
		const resolved = target(ctx.cwd)
		const deps = dependencies(vi.fn())
		deps.resolveTarget = vi.fn(async () => resolved)
		deps.cleanSnapshots = vi
			.fn()
			.mockRejectedValueOnce(new ReviewTargetError("not_a_worktree", "not a worktree"))
			.mockRejectedValueOnce(new Error("deferred sweep failed"))
		await runReviewCommand("https://github.com/owner/repository/pull/42", ctx, api, { dependencies: deps })
		expect(deps.cleanSnapshots).toHaveBeenCalledTimes(2)
		expect(resolved.cleanup).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledWith("Review failed: deferred sweep failed", "error")
	})

	it("cancels pending target resolution with the operation signal", async () => {
		const ctx = context()
		const { api } = createExtensionApi()
		const deps = dependencies(vi.fn())
		deps.resolveTarget = vi.fn((_request, options) => {
			return new Promise<Awaited<ReturnType<ReviewCommandDependencies["resolveTarget"]>>>((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true })
			})
		})
		const pending = runReviewCommand("working-tree", ctx, api, { dependencies: deps })
		await vi.waitFor(() => expect(deps.resolveTarget).toHaveBeenCalledTimes(1))
		sendTerminalInput(ctx, "")
		await pending
		expect(deps.runPanel).not.toHaveBeenCalled()
		expect(activeReviewForTest(ctx.sessionManager.getSessionId())).toBeUndefined()
	})

	it("cancels the active review when its cache lock is compromised", async () => {
		const ctx = context()
		const { api } = createExtensionApi()
		const deps = dependencies(vi.fn())
		deps.resolveTarget = vi.fn((_request, options) => {
			const pending = new Promise<Awaited<ReturnType<ReviewCommandDependencies["resolveTarget"]>>>(
				(_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true })
				},
			)
			queueMicrotask(() => {
				options.onCacheCompromised?.(
					new ReviewTargetError("repository_cache_compromised", "The cache owner was compromised."),
				)
			})
			return pending
		})
		await runReviewCommand("https://github.com/owner/repository/pull/42", ctx, api, { dependencies: deps })
		expect(deps.runPanel).not.toHaveBeenCalled()
		expect(ctx.ui.notify).toHaveBeenCalledWith("Review failed: The cache owner was compromised.", "error")
		expect(activeReviewForTest(ctx.sessionManager.getSessionId())).toBeUndefined()
	})

	it.each([
		["divergence selection", "divergence"],
		["base confirmation", "confirmation"],
		["free-text base entry", "input"],
	] as const)("settles and cleans up after Escape during %s", async (_name, kind) => {
		await assertPromptEscapeSettles(kind)
	})

	it("clears the widget after an input-driven cancellation", async () => {
		const ctx = context()
		const { api } = createExtensionApi()
		const runPanel = vi.fn((options: Parameters<ReviewCommandDependencies["runPanel"]>[0]) => {
			return new Promise<Awaited<ReturnType<ReviewCommandDependencies["runPanel"]>>>((_, reject) => {
				options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true })
			})
		}) as ReviewCommandDependencies["runPanel"]
		const pending = runReviewCommand("working-tree --lens spec", ctx, api, {
			dependencies: dependencies(runPanel, ctx.cwd),
		})
		await vi.waitFor(() => expect(runPanel).toHaveBeenCalledTimes(1))
		sendTerminalInput(ctx, "")
		await pending
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("review-panel", undefined, { placement: "aboveEditor" })
		expect(ctx.ui.notify).toHaveBeenCalledWith("Review failed: Review interrupted by the user.", "error")
	})

	it("reports command errors even when no UI notification channel exists", async () => {
		const ctx = context()
		ctx.hasUI = false
		ctx.mode = "print"
		const { api } = createExtensionApi()
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const previousExitCode = process.exitCode
		try {
			await withPrintGate({ print: false }, () => runReviewCommand("--bogus", ctx, api))
			expect(error).toHaveBeenCalledWith('Review error [invalid_arguments]: Unknown review target option "--bogus".')
			expect(process.exitCode).toBe(1)
			expect(ctx.ui.notify).not.toHaveBeenCalled()
		} finally {
			process.exitCode = previousExitCode
			error.mockRestore()
		}
	})
})
