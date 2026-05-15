import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./agent-runner.js", () => ({
	runAgent: vi.fn(),
	resumeAgent: vi.fn(),
}))

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { AgentManager } from "./agent-manager.js"
import { runAgent } from "./agent-runner.js"

const mockRunAgent = vi.mocked(runAgent)

function fakePi(): ExtensionAPI {
	return {} as ExtensionAPI
}

function fakeCtx(): ExtensionContext {
	return {} as ExtensionContext
}

describe("AgentManager", () => {
	let manager: AgentManager | undefined

	afterEach(() => {
		manager?.dispose()
		manager = undefined
		vi.clearAllMocks()
	})

	it("marks a run as aborted when runAgent reports an abort", async () => {
		mockRunAgent.mockResolvedValueOnce({
			responseText: "partial output",
			session: { dispose: vi.fn() } as unknown as AgentSession,
			aborted: true,
			abortReason: "token_budget",
			steered: false,
		})
		manager = new AgentManager()

		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
		})

		expect(record.status).toBe("aborted")
		expect(record.abortReason).toBe("token_budget")
		expect(record.result).toBe("partial output")
	})
})
