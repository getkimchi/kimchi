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

import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createContext } from "../../__mocks__/context.js"
import { flushWorkSummaries } from "../../work-attribution/summary.js"
import { getWorkId, getWorkSegment, setWorkId } from "../../work-attribution.js"
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
	try {
		manager.spawn({} as ExtensionAPI, ctx, "Explore", "one", { description: "one", isBackground: true })
		const queued = manager.spawn({} as ExtensionAPI, ctx, "Explore", "two", { description: "two", isBackground: true })
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
