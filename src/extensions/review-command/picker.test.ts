import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommandContext } from "../__mocks__/context.js"
import { getReviewTargetChoices } from "../review-targets/index.js"
import type { BareReviewRequest } from "../review-targets/types.js"
import { selectBareTarget } from "./command.js"

const temporaryDirectories: string[] = []

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" })
}

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "review-bare-picker-"))
	temporaryDirectories.push(root)
	git(root, "init", "--initial-branch=main")
	git(root, "config", "user.name", "Bare fixture")
	git(root, "config", "user.email", "[EMAIL_ADDRESS_1]")
	writeFileSync(join(root, "source.ts"), "export const value = 1\n")
	git(root, "add", "source.ts")
	git(root, "commit", "-m", "base")
	return root
}

function writeOwned(root: string, path: string): void {
	const destination = join(root, path)
	mkdirSync(join(destination, ".."), { recursive: true })
	writeFileSync(destination, "generated or user-owned")
}

function bare(): BareReviewRequest {
	return { kind: "bare", fetch: false, panel: { lenses: [], all: false, concurrency: 1 } }
}

describe("bare review picker exclusions", () => {
	it("preselects Branch when only generated review files changed", async () => {
		const root = repository()
		writeOwned(root, ".kimchi/review-output/runs/old/state/panel.json")
		const ctx = createCommandContext()
		ctx.cwd = root
		vi.mocked(ctx.ui.select).mockResolvedValue(undefined)
		const selection = await selectBareTarget(bare(), ctx, { choices: getReviewTargetChoices })
		expect(selection.request).toBeUndefined()
		expect(vi.mocked(ctx.ui.select).mock.calls[0]?.[1]).toEqual(["Branch (default)", "Working tree"])
	})

	it("preselects Working tree for a user-owned .kimchi file", async () => {
		const root = repository()
		writeOwned(root, ".kimchi/review-output/runs/old/state/panel.json")
		writeOwned(root, ".kimchi/notes/user-owned.ts")
		const ctx = createCommandContext()
		ctx.cwd = root
		vi.mocked(ctx.ui.select).mockResolvedValue("Working tree (default)")
		const selection = await selectBareTarget(bare(), ctx, { choices: getReviewTargetChoices })
		expect(selection.request?.kind).toBe("working-tree")
		expect(vi.mocked(ctx.ui.select).mock.calls[0]?.[1]).toEqual(["Working tree (default)", "Branch"])
	})
})
