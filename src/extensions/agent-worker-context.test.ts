import { afterEach, describe, expect, it } from "vitest"
import {
	getAgentStructuredOutput,
	isAgentWorker,
	runAsAgentWorker,
	setAgentStructuredOutput,
} from "./agent-worker-context.js"
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

describe("getAgentStructuredOutput", () => {
	it("returns undefined by default inside a fresh worker run before anything is set", async () => {
		let result: unknown = "sentinel"
		await runAsAgentWorker(async () => {
			result = getAgentStructuredOutput()
		})
		expect(result).toBeUndefined()
	})
})

describe("setAgentStructuredOutput / getAgentStructuredOutput round-trip", () => {
	it("returns the value that was set within the same runAsAgentWorker scope", async () => {
		const payload = { status: "approved", summary: "looks good", required_changes: [], reservations: [], questions: [] }
		let captured: unknown

		await runAsAgentWorker(async () => {
			setAgentStructuredOutput(payload)
			captured = getAgentStructuredOutput()
		})

		expect(captured).toEqual(payload)
	})

	it("preserves the exact object reference that was set", async () => {
		const obj = { nested: { deep: true } }
		let captured: unknown

		await runAsAgentWorker(async () => {
			setAgentStructuredOutput(obj)
			captured = getAgentStructuredOutput()
		})

		expect(captured).toBe(obj)
	})
})

describe("setAgentStructuredOutput outside a worker run", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
	})

	it("does not throw when called outside runAsAgentWorker", () => {
		expect(() => setAgentStructuredOutput({ anything: true })).not.toThrow()
	})

	it("getter returns undefined after a no-op set outside worker scope", () => {
		setAgentStructuredOutput({ anything: true })
		// getAgentStructuredOutput() outside a worker scope reads from undefined store
		expect(getAgentStructuredOutput()).toBeUndefined()
	})
})

describe("AsyncLocalStorage isolation between concurrent runAsAgentWorker scopes", () => {
	it("two concurrent scopes do not leak structuredOutput into each other", async () => {
		const payloadA = { run: "A" }
		const payloadB = { run: "B" }

		let seenInA: unknown
		let seenInB: unknown

		// Both scopes run concurrently. Each sets its own output, then both read
		// after the other has also set — confirming the stores are independent.
		let resolveBarrierA!: () => void
		let resolveBarrierB!: () => void
		const barrierA = new Promise<void>((r) => {
			resolveBarrierA = r
		})
		const barrierB = new Promise<void>((r) => {
			resolveBarrierB = r
		})

		const runA = runAsAgentWorker(async () => {
			setAgentStructuredOutput(payloadA)
			resolveBarrierA()
			await barrierB
			seenInA = getAgentStructuredOutput()
		})

		const runB = runAsAgentWorker(async () => {
			setAgentStructuredOutput(payloadB)
			resolveBarrierB()
			await barrierA
			seenInB = getAgentStructuredOutput()
		})

		await Promise.all([runA, runB])

		expect(seenInA).toBe(payloadA)
		expect(seenInB).toBe(payloadB)
	})
})
