import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { populateCliArgs } from "../../cli-args.js"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { withPrintGate } from "../print-mode.js"
import { runReviewCommand } from "./command.js"

const temporaryDirectories: string[] = []
const previousExitCode = process.exitCode

afterEach(() => {
	vi.restoreAllMocks()
	populateCliArgs([])
	process.exitCode = previousExitCode
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function sandbox(): string {
	const root = mkdtempSync(join(tmpdir(), "review-local-print-"))
	temporaryDirectories.push(root)
	return root
}

function dependencies(
	root: string,
	summaryPath: string,
	runPanel = vi.fn(async () => ({
		progress: { coverage: { status: "complete", unfinished_lenses: [] } },
		findings: [],
		summaryPath,
	})),
) {
	return {
		cleanSnapshots: async () => [],
		recoverWorktrees: async () => [],
		readSettings: () => ({ requiredLenses: [], checkDefinitions: [] }) as never,
		resolveTarget: vi.fn(async () => ({
			scope: {
				kind: "working-tree",
				checkoutPath: root,
				files: { changed: 1 },
				pinned: { baseSha: "a", headSha: "b" },
			},
			cleanup: async () => {},
		})) as never,
		resolvePanel: () => ({ lenses: [], slotCount: 1 }) as never,
		runPanel: runPanel as never,
	}
}

describe("local review print mode", () => {
	it("prints a local failure and sets a failing exit code", async () => {
		const root = sandbox()
		const ctx = createCommandContext()
		ctx.cwd = root
		ctx.hasUI = false
		const { api } = createExtensionApi()
		mkdirSync(join(root, ".kimchi", "review-output"), { recursive: true })
		writeFileSync(join(root, ".kimchi", "review-output", "active-review.json"), "{}")
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const summaryPath = join(root, "report.json")
		const deps = dependencies(root, summaryPath)

		await withPrintGate({ print: true }, () =>
			runReviewCommand("working-tree --lens spec", ctx, api, { dependencies: deps }),
		)

		expect(process.exitCode).toBe(1)
		expect(error).toHaveBeenCalledWith(expect.stringContaining("Review error [review_lock_invalid]:"))
		expect(deps.runPanel).not.toHaveBeenCalled()
	})

	it("prints the result summary and report path after a successful local review", async () => {
		const root = sandbox()
		const ctx = createCommandContext()
		ctx.cwd = root
		ctx.hasUI = false
		const { api } = createExtensionApi()
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const summaryPath = join(root, "report.json")
		const deps = dependencies(root, summaryPath)
		populateCliArgs(["--review-save-sessions"])

		await withPrintGate({ print: true }, () =>
			runReviewCommand("working-tree --lens spec", ctx, api, {
				dependencies: deps,
			}),
		)

		expect(process.exitCode).not.toBe(1)
		expect(deps.runPanel).toHaveBeenCalledWith(expect.objectContaining({ saveSessions: true }))
		expect(log).toHaveBeenCalledWith(
			`Review complete: 0 final findings.\nComplete review coverage.\nReport: ${summaryPath}`,
		)
		expect(existsSync(join(root, ".kimchi", "review-output", "active-review.json"))).toBe(false)
	})

	it("rejects local targets when only manifest and wrap-up are allowed", async () => {
		const root = sandbox()
		const ctx = createCommandContext()
		ctx.cwd = root
		ctx.hasUI = false
		const { api } = createExtensionApi()
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const deps = dependencies(root, join(root, "report.json"))

		await withPrintGate({ print: true }, () =>
			runReviewCommand("working-tree", ctx, api, { allowLocal: false, dependencies: deps }),
		)

		expect(process.exitCode).toBe(1)
		expect(error).toHaveBeenCalledWith(
			"Review error [invalid_arguments]: Local /review targets require --enable-experimental-features; use --manifest or wrap-up.",
		)
		expect(deps.resolveTarget).not.toHaveBeenCalled()
		expect(deps.runPanel).not.toHaveBeenCalled()
	})
})
