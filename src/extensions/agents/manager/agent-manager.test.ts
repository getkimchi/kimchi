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

describe("AgentManager visibility", () => {
	it("stores system visibility on queued records", () => {
		const manager = new AgentManager(undefined, 0)
		try {
			const first = manager.spawn({} as never, {} as never, "General-Purpose", "one", {
				description: "visible agent",
				isBackground: true,
			})
			const second = manager.spawn({} as never, {} as never, "General-Purpose", "two", {
				description: "system agent",
				isBackground: true,
				visibility: "system",
			})

			expect(manager.getRecord(first)?.visibility).toBe("user")
			expect(manager.getRecord(second)?.visibility).toBe("system")
			expect(manager.getRecord(second)?.status).toBe("queued")
		} finally {
			manager.dispose()
		}
	})
})
