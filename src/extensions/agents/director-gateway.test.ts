import { describe, expect, it, vi } from "vitest"
import { createDirectorWorkerGateway } from "./director-gateway.js"
import type { AgentManager } from "./manager/agent-manager.js"
import type { AgentRecord } from "./personas/types.js"

describe("Director worker gateway", () => {
	it("projects serializable lifecycle fields and aborts only the requested worker", () => {
		const record = {
			id: "agent-1",
			type: "Builder",
			description: "Test worker",
			status: "running",
			remote: true,
			result: "result summary",
			session: { secret: "runtime session" },
			abortController: new AbortController(),
			startedAt: 10,
		} as unknown as AgentRecord
		const abort = vi.fn(() => true)
		const manager = {
			listAgents: () => [record],
			abort,
		} as unknown as Pick<AgentManager, "listAgents" | "abort">
		const gateway = createDirectorWorkerGateway(manager)

		expect(gateway.list()).toEqual([
			{
				id: "agent-1",
				type: "Builder",
				description: "Test worker",
				status: "running",
				remote: true,
				result: "result summary",
				error: undefined,
				startedAt: 10,
				completedAt: undefined,
			},
		])
		expect(gateway.list()[0]).not.toHaveProperty("session")
		expect(gateway.list()[0]).not.toHaveProperty("abortController")

		expect(gateway.abort("agent-1")).toBe(true)
		expect(abort).toHaveBeenCalledExactlyOnceWith("agent-1")
	})
})
