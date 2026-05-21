import { afterEach, describe, expect, it } from "vitest"
import promptSummaryExtension from "./prompt-summary.js"

type Handler = (event?: unknown) => void | Promise<void>

function createPiHarness() {
	const handlers = new Map<string, Handler[]>()
	const sent: unknown[] = []
	return {
		pi: {
			on(event: string, handler: Handler) {
				const list = handlers.get(event) ?? []
				list.push(handler)
				handlers.set(event, list)
			},
			registerMessageRenderer() {},
			sendMessage(message: unknown) {
				sent.push(message)
			},
		},
		async emit(event: string, payload?: unknown) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload)
			}
		},
		sent,
	}
}

describe("prompt summary Agent token accounting", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
	})

	it("adds deltas for repeated results from the same running Agent", async () => {
		const harness = createPiHarness()
		promptSummaryExtension(harness.pi as never)

		await harness.emit("agent_start")
		await harness.emit("tool_result", {
			toolName: "get_subagent_result",
			details: { agentId: "agent-1", tokenUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 1 } },
		})
		await harness.emit("tool_result", {
			toolName: "get_subagent_result",
			details: { agentId: "agent-1", tokenUsage: { input: 18, output: 9, cacheRead: 0, cacheWrite: 3 } },
		})
		await harness.emit("agent_end")
		await new Promise((resolve) => setTimeout(resolve, 0))

		const message = harness.sent[0] as {
			details: { subagents: { input: number; output: number; cacheRead: number; cacheWrite: number } }
		}
		expect(message.details.subagents).toEqual({ input: 18, output: 9, cacheRead: 0, cacheWrite: 3 })
	})
})
