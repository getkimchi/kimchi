import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { runAsAgentWorker } from "../agent-worker-context.js"
import workspaceCheckpointsExtension, { FINALIZATION_MESSAGE_TYPE, WORKSPACE_CHECKPOINT_ENTRY_TYPE } from "./index.js"

const execFileAsync = promisify(execFile)
let dir: string
let repo: string
let state: string

function ctx(sessionId = "test-session") {
	return createContext({
		cwd: repo,
		sessionManager: { getSessionId: () => sessionId },
		abort: vi.fn(),
	})
}

async function initRepo(): Promise<void> {
	writeFileSync(join(repo, "seed.txt"), "original\n")
	await execFileAsync("git", ["init", "-q"], { cwd: repo })
	await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo })
	await execFileAsync("git", ["config", "user.email", "test@local"], { cwd: repo })
	await execFileAsync("git", ["add", "seed.txt"], { cwd: repo })
	await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: repo })
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-checkpoint-extension-"))
	repo = join(dir, "work")
	state = join(dir, "state")
	mkdirSync(repo, { recursive: true })
	await initRepo()
})

afterEach(() => {
	vi.useRealTimers()
	rmSync(dir, { recursive: true, force: true })
})

describe("workspace-checkpoints extension", () => {
	it("does nothing when there is no configured deadline", () => {
		const mock = createExtensionApi()
		workspaceCheckpointsExtension(mock.api)
		expect(mock.getHandlers("session_start")).toHaveLength(0)
		expect(mock.getRegisteredTools()).toHaveLength(0)
	})

	it("never registers for agent workers", async () => {
		const mock = createExtensionApi()
		await runAsAgentWorker(async () => {
			workspaceCheckpointsExtension(mock.api, { maxSessionDurationSeconds: 60, stateDir: state })
		})
		expect(mock.getHandlers("session_start")).toHaveLength(0)
		expect(mock.getRegisteredTools()).toHaveLength(0)
	})

	it("captures mutating tools and persists checkpoint metadata without changing project refs", async () => {
		const refsBefore = readFileSync(join(repo, ".git", "refs", "heads", "master"), "utf8")
		const mock = createExtensionApi()
		workspaceCheckpointsExtension(mock.api, { maxSessionDurationSeconds: 60, stateDir: state })
		const context = ctx()
		await mock.emit("session_start", {}, context)
		await mock.emit("agent_start", {}, context)
		await vi.waitFor(() => expect(mock.getAppendedEntries(WORKSPACE_CHECKPOINT_ENTRY_TYPE).length).toBe(1))
		writeFileSync(join(repo, "created.txt"), "created\n")
		await mock.emit("tool_execution_start", { toolName: "write" }, context)
		await mock.emit("tool_execution_end", { toolName: "write" }, context)
		await mock.emit("session_shutdown", {}, context)
		const entries = mock.getAppendedEntries<{ checkpoint: { trigger: string } }>(WORKSPACE_CHECKPOINT_ENTRY_TYPE)
		expect(entries.some((entry) => entry.checkpoint.trigger === "session-start")).toBe(true)
		expect(entries.some((entry) => entry.checkpoint.trigger === "turn-end")).toBe(true)
		expect(readFileSync(join(repo, ".git", "refs", "heads", "master"), "utf8")).toBe(refsBefore)
	})

	it("isolates shutdown drains by session", async () => {
		const mockOne = createExtensionApi()
		const mockTwo = createExtensionApi()
		workspaceCheckpointsExtension(mockOne.api, { maxSessionDurationSeconds: 60, stateDir: state })
		workspaceCheckpointsExtension(mockTwo.api, { maxSessionDurationSeconds: 60, stateDir: state })
		const one = ctx("one")
		const two = ctx("two")
		await Promise.all([mockOne.emit("session_start", {}, one), mockTwo.emit("session_start", {}, two)])
		writeFileSync(join(repo, "artifact.txt"), "result")
		await Promise.all([
			(async () => {
				await mockOne.emit("tool_execution_start", { toolName: "write" }, one)
				await mockOne.emit("tool_execution_end", { toolName: "write" }, one)
				await mockOne.emit("session_shutdown", {}, one)
			})(),
			(async () => {
				await mockTwo.emit("tool_execution_start", { toolName: "write" }, two)
				await mockTwo.emit("tool_execution_end", { toolName: "write" }, two)
				await mockTwo.emit("session_shutdown", {}, two)
			})(),
		])
		expect(mockOne.getAppendedEntries(WORKSPACE_CHECKPOINT_ENTRY_TYPE).length).toBeGreaterThan(0)
		expect(mockTwo.getAppendedEntries(WORKSPACE_CHECKPOINT_ENTRY_TYPE).length).toBeGreaterThan(0)
	})

	it("emits one marked finalization inside an active run and disposes it on settlement", async () => {
		const mock = createExtensionApi()
		workspaceCheckpointsExtension(mock.api, { maxSessionDurationSeconds: 1, stateDir: state })
		const context = ctx()
		await mock.emit("session_start", {}, context)
		await mock.emit("agent_start", {}, context)
		await vi.waitFor(() => expect(mock.sendMessage).toHaveBeenCalledTimes(1), { timeout: 3000 })
		const message = mock.sendMessage.mock.calls[0]?.[0] as { content: string }
		expect(message.content).toContain("<system-reminder>")
		expect(message.content).toContain("near its deadline")
		expect(mock.getAppendedEntries(FINALIZATION_MESSAGE_TYPE)).toHaveLength(1)
		await mock.emit("agent_settled", {}, context)
		await mock.emit("session_shutdown", {}, context)
		expect(context.abort).not.toHaveBeenCalled()
	})
})
