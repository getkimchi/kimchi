import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("./agent-runner.js", () => ({
	runAgent: vi.fn(),
	resumeAgent: vi.fn(),
	MIN_TOKEN_BUDGET: 1024,
	MIN_FINALIZE_TOKEN_BUDGET: 256,
}))
vi.mock("./remote-agent-runner.js", () => ({
	runRemoteAgent: vi.fn(),
	continueRemoteAgent: vi.fn(),
	attachRemoteAgent: vi.fn(),
	isRemoteSessionConnected: vi.fn(),
}))

import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { createContext, createLiveContext } from "../../__mocks__/context.js"
import { createExtensionApi } from "../../__mocks__/extension-api.js"
import { createModel } from "../../__mocks__/model-registry.js"
import { flushWorkSummaries } from "../../work-attribution/summary.js"
import { appendWorkRecord, getWorkId, getWorkSegment, setWorkId } from "../../work-attribution.js"
import { AgentManager } from "./agent-manager.js"
import { runAgent } from "./agent-runner.js"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-agent-queued-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.unstubAllEnvs()
	vi.clearAllMocks()
	rmSync(dir, { recursive: true, force: true })
})

it("starts a queued background child in the work and segment active when it was spawned", async () => {
	const ctx = createContext({ cwd: dir })
	const spawnedIn = getWorkId(ctx)
	const spawnedSegment = getWorkSegment(ctx)
	// runAgentInner() captures getWorkId(ctx)/getWorkSegment(ctx) as soon as runAgent() starts.
	const inherited: { workId: string; segment: unknown }[] = []
	let finishFirst!: () => void
	vi.mocked(runAgent).mockImplementation(async (childCtx) => {
		inherited.push({ workId: getWorkId(childCtx), segment: getWorkSegment(childCtx) })
		if (inherited.length === 1) await new Promise<void>((resolve) => (finishFirst = resolve))
		return {
			responseText: "done",
			session: { dispose: vi.fn() } as unknown as AgentSession,
			aborted: false,
			steered: false,
		}
	})
	const manager = new AgentManager(undefined, 1)
	const pi = createExtensionApi().api
	try {
		manager.spawn(pi, ctx, "Explore", "one", { description: "one", isBackground: true })
		const queued = manager.spawn(pi, ctx, "Explore", "two", { description: "two", isBackground: true })
		expect(manager.getRecord(queued)?.status).toBe("queued")
		// The parent moves on (/work new, a pasted plan, or a semantic "new" decision).
		setWorkId(ctx)
		finishFirst()
		await vi.waitFor(() => expect(inherited).toHaveLength(2))
		expect(inherited[1]).toEqual({ workId: spawnedIn, segment: spawnedSegment })
	} finally {
		manager.dispose()
	}
})

it("pins only the work for a queued child; Pi's context getters and stale guard stay live", async () => {
	const parent = createLiveContext({ cwd: dir, model: createModel("model-at-spawn") })
	const spawnedIn = randomUUID()
	const spawnedSegment = { id: randomUUID(), attribution: "session", reason: "matching-disabled" } as const
	// A restored ledger gives the parent an active input segment.
	appendWorkRecord(parent.ctx, { type: "work", segment: spawnedSegment }, spawnedIn)
	expect([getWorkId(parent.ctx), getWorkSegment(parent.ctx)]).toEqual([spawnedIn, spawnedSegment])
	const read = (value: () => unknown) => {
		try {
			return value()
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
	}
	const started: Record<string, unknown>[] = []
	const finish: (() => void)[] = []
	vi.mocked(runAgent).mockImplementation(async (childCtx) => {
		started.push({
			workId: getWorkId(childCtx),
			segment: getWorkSegment(childCtx),
			model: read(() => childCtx.model?.id),
			session: read(() => childCtx.sessionManager.getSessionId()),
		})
		await new Promise<void>((resolve) => finish.push(resolve))
		return {
			responseText: "done",
			session: { dispose: vi.fn() } as unknown as AgentSession,
			aborted: false,
			steered: false,
		}
	})
	const manager = new AgentManager(undefined, 1)
	const pi = createExtensionApi().api
	try {
		for (const name of ["running", "after-model-change", "after-session-replacement"])
			manager.spawn(pi, parent.ctx, "Explore", name, { description: name, isBackground: true })
		setWorkId(parent.ctx)
		parent.set("model", createModel("model-at-start"))
		finish[0]()
		await vi.waitFor(() => expect(started).toHaveLength(2))
		parent.invalidate()
		finish[1]()
		await vi.waitFor(() => expect(started).toHaveLength(3))
		finish[2]()
		const pinned = { workId: spawnedIn, segment: spawnedSegment }
		expect(started[1]).toEqual({ ...pinned, model: "model-at-start", session: "test-session" })
		expect(started[2]).toEqual({
			...pinned,
			model: expect.stringContaining("stale"),
			session: expect.stringContaining("stale"),
		})
	} finally {
		manager.dispose()
	}
})
