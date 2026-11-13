import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./agent-runner.js", () => ({
	runAgent: vi.fn(),
	resumeAgent: vi.fn(),
	MIN_TOKEN_BUDGET: 1024,
	MIN_FINALIZE_TOKEN_BUDGET: 256,
}))

vi.mock("../../../config.js", () => ({
	loadConfig: vi.fn().mockReturnValue({ apiKey: "test-key" }),
	readGitToken: vi.fn(),
}))

vi.mock("../../../sandbox/cloud/workspaces.js", () => ({
	listWorkspaces: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../../sandbox/cloud/workspace-file.js", () => ({
	loadWorkspaceFile: vi.fn(),
}))

vi.mock("../../teleport/provisioning/clone-plan.js", () => ({
	resolveClonePlan: vi.fn(),
}))

vi.mock("../../teleport/provisioning/paths.js", () => ({
	repoBasename: vi.fn().mockReturnValue("repo"),
}))

vi.mock("./remote-agent-runner.js", () => ({
	runRemoteAgent: vi.fn(),
	continueRemoteAgent: vi.fn(),
	attachRemoteAgent: vi.fn(),
	isRemoteSessionConnected: vi.fn(),
	discardLiveKeptAcpClient: vi.fn(),
	deleteRemoteSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../teleport/ui/git-token-prompt.js", () => ({
	GitTokenPromptComponent: vi.fn(),
}))

vi.mock("../../teleport/provisioning/git-token.js", () => ({
	resolveGitToken: vi.fn(),
}))

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createContext } from "../../__mocks__/context.js"
import { createExtensionApi } from "../../__mocks__/extension-api.js"
import { AgentManager } from "./agent-manager.js"
import { runAgent } from "./agent-runner.js"

const mockRunAgent = vi.mocked(runAgent)

function fakePi(): ExtensionAPI {
	return createExtensionApi().api
}

/** Make an agent context whose cwd is a git repo with one commit. */
async function repoCtx(cwd: string): Promise<ExtensionContext> {
	return { ...createContext(), cwd }
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		.toString()
		.trim()
}

let main: string

beforeEach(async () => {
	const raw = await mkdtemp(join(tmpdir(), "wt-agent-"))
	main = await realpath(raw)
	git(main, ["init", "-q"])
	git(main, ["config", "user.email", "wt@test"])
	git(main, ["config", "user.name", "Agent Worktree Test"])
	await writeFile(join(main, "README.md"), "# agent worktree\n")
	git(main, ["add", "README.md"])
	git(main, ["commit", "-q", "-m", "init"])
})

afterEach(async () => {
	vi.clearAllMocks()
	await rm(main, { recursive: true, force: true })
})

function runResult(overrides: Partial<Parameters<typeof runAgent>[0]> extends never ? object : object = {}) {
	return {
		responseText: "done",
		session: { dispose: vi.fn() } as unknown as AgentSession,
		aborted: false,
		steered: false,
		maxTurns: 3,
		...overrides,
	}
}

describe("isolation: worktree", () => {
	it("creates a disposable worktree and passes its cwd to the runner", async () => {
		mockRunAgent.mockImplementationOnce(async (_ctx, _type, _prompt, opts) => {
			const cwd = opts?.cwd
			if (!cwd) throw new Error("expected runAgent to receive the worktree cwd")
			expect(cwd).toMatch(/\.kimchi\/worktrees\/agent-/)
			expect(existsSync(join(cwd, ".git"))).toBe(true)
			return runResult({ responseText: `ran in ${cwd}` })
		})

		const manager = new AgentManager()
		try {
			const record = await manager.spawnAndWait(fakePi(), await repoCtx(main), "Explore", "do work", {
				description: "worktree isolation",
				isolation: "worktree",
			})
			expect(record.result).toContain("ran in")
			expect(record.worktree).toBeUndefined() // settled — removed (clean)
		} finally {
			manager.dispose()
		}
		const worktrees = git(main, ["worktree", "list", "--porcelain"])
			.split("\n\n")
			.filter((e) => e.includes(".kimchi/worktrees/"))
		expect(worktrees).toHaveLength(0) // clean run removed the worktree
	})

	it("keeps a dirty worktree and reports its path when the agent leaves work", async () => {
		mockRunAgent.mockImplementationOnce(async (_ctx, _type, _prompt, opts) => {
			const cwd = opts?.cwd
			if (!cwd) throw new Error("expected worktree cwd")
			await writeFile(join(cwd, "result.md"), "agent left this\n")
			return runResult({ responseText: "left files" })
		})

		const manager = new AgentManager()
		let record: Awaited<ReturnType<AgentManager["spawnAndWait"]>>
		try {
			record = await manager.spawnAndWait(fakePi(), await repoCtx(main), "Explore", "leave files", {
				description: "dirty worktree",
				isolation: "worktree",
			})
		} finally {
			manager.dispose()
		}
		expect(record.result).toContain("Worktree: ")
		expect(record.result).toContain(".kimchi/worktrees/agent-")
		expect(record.result).toContain("(branch worktree-agent-")
		expect(record.worktree).toBeDefined() // kept for the parent to reconcile
	})

	it("does not isolate when isolation is unset", async () => {
		mockRunAgent.mockImplementationOnce(async (_ctx, _type, _prompt, opts) => {
			expect(opts?.cwd).toBeUndefined()
			return runResult()
		})

		const manager = new AgentManager()
		try {
			await manager.spawnAndWait(fakePi(), await repoCtx(main), "Explore", "plain", {
				description: "no isolation",
			})
		} finally {
			manager.dispose()
		}
		const worktrees = git(main, ["worktree", "list", "--porcelain"])
			.split("\n\n")
			.filter((e) => e.includes(".kimchi/worktrees/"))
		expect(worktrees).toHaveLength(0)
	})
})
