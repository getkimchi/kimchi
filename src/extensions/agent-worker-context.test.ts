import { afterEach, describe, expect, it } from "vitest"
import { isAgentWorker, runAsAgentWorker } from "./agent-worker-context.js"
import { isSubagent } from "./prompt-construction/prompt-enrichment.js"

describe("agent worker context", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
	})

	it("marks async in-process Agent execution as worker mode without mutating env", async () => {
		expect(isAgentWorker()).toBe(false)
		expect(isSubagent()).toBe(false)

		await runAsAgentWorker(async () => {
			expect(process.env.KIMCHI_SUBAGENT).toBeUndefined()
			expect(isAgentWorker()).toBe(true)
			expect(isSubagent()).toBe(true)
			await Promise.resolve()
			expect(isAgentWorker()).toBe(true)
		})

		expect(isAgentWorker()).toBe(false)
		expect(isSubagent()).toBe(false)
	})

	it("still honors the legacy subprocess env marker", () => {
		process.env.KIMCHI_SUBAGENT = "1"
		expect(isAgentWorker()).toBe(true)
		expect(isSubagent()).toBe(true)
	})
})
