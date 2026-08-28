import { afterEach, describe, expect, it } from "vitest"
import { getConversationId, isAgentWorker, resetConversationId, runAsAgentWorker } from "./agent-worker-context.js"
import { isSubagent } from "./prompt-construction/prompt-enrichment.js"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

describe("conversationId", () => {
	it("returns a UUID outside any worker context", () => {
		const id = getConversationId()
		expect(id).toMatch(UUID_RE)
	})

	it("returns a different UUID inside runAsAgentWorker than outside", async () => {
		const outerId = getConversationId()
		let innerId = ""
		await runAsAgentWorker(async () => {
			innerId = getConversationId()
		})
		expect(innerId).toMatch(UUID_RE)
		expect(innerId).not.toBe(outerId)
		// After the worker exits, the outer id is restored
		expect(getConversationId()).toBe(outerId)
	})

	it("resetConversationId changes the module-level default", () => {
		const before = getConversationId()
		resetConversationId()
		const after = getConversationId()
		expect(after).toMatch(UUID_RE)
		expect(after).not.toBe(before)
	})

	it("nested runAsAgentWorker calls produce distinct conversationIds", async () => {
		const outer = getConversationId()
		let midId = ""
		let innerId = ""

		await runAsAgentWorker(async () => {
			midId = getConversationId()
			expect(midId).not.toBe(outer)

			await runAsAgentWorker(async () => {
				innerId = getConversationId()
			})

			// After inner exits, mid is restored
			expect(getConversationId()).toBe(midId)
		})

		expect(innerId).not.toBe(midId)
		expect(innerId).not.toBe(outer)
		expect(getConversationId()).toBe(outer)
	})

	it("resetConversationId does not affect an in-flight worker context", async () => {
		const outer = getConversationId()
		let workerId = ""
		let afterReset = ""

		await runAsAgentWorker(async () => {
			workerId = getConversationId()
			resetConversationId() // regenerates the module-level default, not the async context value
			afterReset = getConversationId()
		})

		expect(workerId).not.toBe(outer)
		expect(afterReset).toBe(workerId) // async context value is untouched by reset
		expect(getConversationId()).not.toBe(outer) // module-level default changed
	})
})
