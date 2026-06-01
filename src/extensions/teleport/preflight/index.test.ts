import { describe, expect, it, vi } from "vitest"
import { TeleportRefusal } from "../commands/errors.js"
import type { TeleportContext } from "../types.js"
import { type PreflightDeps, runPreflight } from "./index.js"

function makeCtx(): TeleportContext & {
	ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> }
} {
	const ui = {
		notify: vi.fn(),
		setStatus: vi.fn(),
	}
	return {
		apiKey: "key",
		endpoint: undefined,
		cwd: "/work",
		signal: undefined,
		ui: ui as unknown as TeleportContext["ui"],
	} as TeleportContext & { ui: typeof ui }
}

function makeDeps(over: Partial<PreflightDeps> = {}): PreflightDeps {
	return {
		whichRsync: () => true,
		gitWorkingTreeDirty: () => false,
		estimateWorkspaceBytes: () => 0,
		rsyncInstallHint: () => "install hint",
		...over,
	}
}

describe("runPreflight", () => {
	it("passes silently on the happy path", () => {
		const { ctx, ui } = wrap()
		expect(() => runPreflight(ctx, {}, makeDeps())).not.toThrow()
		expect(ui.notify).not.toHaveBeenCalled()
	})

	it("refuses with install hint when rsync is missing", () => {
		const { ctx, ui } = wrap()
		expect(() =>
			runPreflight(ctx, {}, makeDeps({ whichRsync: () => false, rsyncInstallHint: () => "brew install rsync" })),
		).toThrow(TeleportRefusal)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("brew install rsync"), "error")
	})

	it("refuses on a dirty working tree without --allow-dirty", () => {
		const { ctx, ui } = wrap()
		expect(() => runPreflight(ctx, {}, makeDeps({ gitWorkingTreeDirty: () => true }))).toThrow(TeleportRefusal)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("--allow-dirty"), "error")
	})

	it("passes a dirty tree when --allow-dirty is set", () => {
		const { ctx, ui } = wrap()
		expect(() => runPreflight(ctx, { allowDirty: true }, makeDeps({ gitWorkingTreeDirty: () => true }))).not.toThrow()
		expect(ui.notify).not.toHaveBeenCalled()
	})

	it("refuses on a workspace over SIZE_REFUSE_BYTES without --force", () => {
		const { ctx, ui } = wrap()
		expect(() => runPreflight(ctx, {}, makeDeps({ estimateWorkspaceBytes: () => 6_000_000_000 }))).toThrow(
			TeleportRefusal,
		)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Workspace is large \(6\.0 GB\)/), "error")
	})

	it("passes a too-large workspace with --force, and still emits a warn", () => {
		const { ctx, ui } = wrap()
		expect(() =>
			runPreflight(ctx, { force: true }, makeDeps({ estimateWorkspaceBytes: () => 6_000_000_000 })),
		).not.toThrow()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("MB"), "warning")
	})

	it("warns (no refuse) for sizes between WARN and REFUSE", () => {
		const { ctx, ui } = wrap()
		expect(() => runPreflight(ctx, {}, makeDeps({ estimateWorkspaceBytes: () => 800_000_000 }))).not.toThrow()
		expect(ui.notify).toHaveBeenCalledTimes(1)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("800 MB"), "warning")
	})

	it("does not warn when size is below SIZE_WARN_BYTES", () => {
		const { ctx, ui } = wrap()
		runPreflight(ctx, {}, makeDeps({ estimateWorkspaceBytes: () => 100_000_000 }))
		expect(ui.notify).not.toHaveBeenCalled()
	})

	it("skips all checks entirely when --git-repo is set", () => {
		const { ctx, ui } = wrap()
		const rsync = vi.fn().mockReturnValue(false)
		const dirty = vi.fn().mockReturnValue(true)
		const size = vi.fn().mockReturnValue(6_000_000_000)
		expect(() =>
			runPreflight(
				ctx,
				{ gitRepo: "https://github.com/me/x.git" },
				makeDeps({
					whichRsync: rsync,
					gitWorkingTreeDirty: dirty,
					estimateWorkspaceBytes: size,
				}),
			),
		).not.toThrow()
		expect(rsync).not.toHaveBeenCalled()
		expect(dirty).not.toHaveBeenCalled()
		expect(size).not.toHaveBeenCalled()
		expect(ui.notify).not.toHaveBeenCalled()
	})

	it("checks in order: rsync → dirty → size (rsync failure shortcircuits)", () => {
		const { ctx } = wrap()
		const dirty = vi.fn().mockReturnValue(true)
		const size = vi.fn().mockReturnValue(6_000_000_000)
		expect(() =>
			runPreflight(
				ctx,
				{},
				makeDeps({
					whichRsync: () => false,
					gitWorkingTreeDirty: dirty,
					estimateWorkspaceBytes: size,
				}),
			),
		).toThrow(TeleportRefusal)
		expect(dirty).not.toHaveBeenCalled()
		expect(size).not.toHaveBeenCalled()
	})
})

function wrap() {
	const ctx = makeCtx()
	return { ctx, ui: ctx.ui }
}
