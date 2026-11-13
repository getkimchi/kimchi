import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@clack/prompts", () => ({
	confirm: vi.fn(),
	isCancel: (value: unknown) => value === Symbol.for("clack:cancel"),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), message: vi.fn() },
}))

import { confirm as clackConfirm } from "@clack/prompts"
import { createWorktree } from "./shared/git/worktree.js"
import { promptWorktreeExit, silentExitDecision } from "./worktree-exit-prompt.js"

const confirmMock = vi.mocked(clackConfirm)

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		.toString()
		.trim()
}

describe("silentExitDecision", () => {
	it("always keeps the worktree in non-interactive paths", () => {
		expect(silentExitDecision()).toEqual({ action: "keep", resumeHint: false })
	})
})

describe("promptWorktreeExit", () => {
	let main: string
	let dir: string
	const name = "feat-x"

	beforeEach(async () => {
		const raw = await mkdtemp(join(tmpdir(), "wt-exit-test-"))
		main = await realpath(raw)
		git(main, ["init", "-q"])
		git(main, ["config", "user.email", "wt@test"])
		git(main, ["config", "user.name", "Exit Prompt Test"])
		await writeFile(join(main, "README.md"), "# test\n")
		git(main, ["add", "README.md"])
		git(main, ["commit", "-q", "-m", "init"])
		const wt = await createWorktree({ mainRoot: main, name })
		dir = wt.path
		// Clear call history AND implementation queues: clearAllMocks does not
		// reset mockResolvedValueOnce queues, which leak across tests in a file.
		confirmMock.mockReset()
	})
	afterEach(async () => {
		try {
			git(main, ["worktree", "remove", "--force", dir])
			git(main, ["branch", "-D", `worktree-${name}`])
		} catch {
			// already gone
		}
		await rm(main, { recursive: true, force: true })
	})

	it("removes an unnamed clean worktree silently", async () => {
		const decision = await promptWorktreeExit({
			dir,
			mainRoot: main,
			name,
			named: false,
			interactive: true,
		})
		expect(decision.action).toBe("remove")
		expect(confirmMock).not.toHaveBeenCalled()
		expect(git(main, ["worktree", "list"]).includes(dir)).toBe(false)
	})

	it("does nothing when not interactive and the worktree has work", async () => {
		await writeFile(join(dir, "WIP.md"), "uncommitted\n")
		const decision = await promptWorktreeExit({
			dir,
			mainRoot: main,
			name,
			named: true,
			interactive: false,
		})
		expect(decision).toEqual(silentExitDecision())
		expect(confirmMock).not.toHaveBeenCalled()
	})

	it("keeps a named clean worktree when the user declines removal (confirm=false)", async () => {
		confirmMock.mockResolvedValue(false as never)
		const decision = await promptWorktreeExit({
			dir,
			mainRoot: main,
			name,
			named: true,
			interactive: true,
		})
		expect(decision.action).toBe("keep")
		expect(confirmMock).toHaveBeenCalledTimes(1)
		expect(git(main, ["worktree", "list"]).includes(dir)).toBe(true)
	})

	it("removes a named clean worktree when the user confirms (confirm=true)", async () => {
		confirmMock.mockResolvedValue(true as never)
		const decision = await promptWorktreeExit({
			dir,
			mainRoot: main,
			name,
			named: true,
			interactive: true,
		})
		expect(decision.action).toBe("remove")
		expect(confirmMock).toHaveBeenCalledTimes(1)
		expect(git(main, ["worktree", "list"]).includes(dir)).toBe(false)
	})

	it("asks twice and keeps when the discard confirmation is declined", async () => {
		await writeFile(join(dir, "WIP.md"), "uncommitted\n")
		// First confirm: remove anyway → true. Second (discard): declined → false.
		confirmMock.mockResolvedValueOnce(true as never).mockResolvedValueOnce(false as never)
		const decision = await promptWorktreeExit({
			dir,
			mainRoot: main,
			name,
			named: true,
			interactive: true,
		})
		expect(decision.action).toBe("keep")
		expect(confirmMock).toHaveBeenCalledTimes(2)
		expect(git(main, ["worktree", "list"]).includes(dir)).toBe(true)
	})

	it("removes a dirty worktree when both confirmations are accepted", async () => {
		await writeFile(join(dir, "WIP.md"), "uncommitted\n")
		confirmMock.mockResolvedValueOnce(true as never).mockResolvedValueOnce(true as never)
		const decision = await promptWorktreeExit({
			dir,
			mainRoot: main,
			name,
			named: true,
			interactive: true,
		})
		expect(decision.action).toBe("remove")
		expect(confirmMock).toHaveBeenCalledTimes(2)
		expect(git(main, ["worktree", "list"]).includes(dir)).toBe(false)
	})

	it("keeps the worktree when the dir is already gone", async () => {
		git(main, ["worktree", "remove", "--force", dir])
		const decision = await promptWorktreeExit({
			dir,
			mainRoot: main,
			name,
			named: true,
			interactive: true,
		})
		expect(decision).toEqual({ action: "remove", resumeHint: false })
	})
})
