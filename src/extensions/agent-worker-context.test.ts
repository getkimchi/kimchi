import { afterEach, describe, expect, it } from "vitest"
import {
	holdAgentWorkerInactivity,
	isAgentWorker,
	runAsAgentWorker,
	runOutsideWorkerContext,
	setAgentWorkerInactivityHold,
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

	it("marks a worker started without any installed hold", async () => {
		await runAsAgentWorker(async () => {
			expect(isAgentWorker()).toBe(true)
			expect(holdAgentWorkerInactivity()).toBeTypeOf("function")
		})
	})

	it("takes and releases the inactivity hold only inside a worker", async () => {
		// Outside a worker the hold is a no-op that stays callable.
		holdAgentWorkerInactivity()()

		let holds = 0
		const releases: string[] = []
		await runAsAgentWorker(async () => {
			let released = false
			setAgentWorkerInactivityHold({
				acquire: () => {
					holds += 1
					return () => {
						if (released) return
						released = true
						holds -= 1
						releases.push("released")
					}
				},
			})
			const release = holdAgentWorkerInactivity()
			expect(holds).toBe(1)
			release()
			release()
			expect(holds).toBe(0)
			expect(releases).toEqual(["released"])
		})
	})

	it("keeps parallel workers' hold implementations isolated", async () => {
		const acquired: string[] = []
		await Promise.all(
			["worker-a", "worker-b"].map((id) =>
				runAsAgentWorker(async () => {
					setAgentWorkerInactivityHold({
						acquire: () => {
							acquired.push(id)
							return () => {}
						},
					})
					await new Promise((resolve) => setTimeout(resolve, 1))
					holdAgentWorkerInactivity()
				}),
			),
		)
		expect(acquired.sort()).toEqual(["worker-a", "worker-b"])
	})

	it("runs a callback outside the worker context for parent-side work", async () => {
		await runAsAgentWorker(async () => {
			expect(isAgentWorker()).toBe(true)
			expect(runOutsideWorkerContext(() => isAgentWorker())).toBe(false)
			expect(await runOutsideWorkerContext(async () => isAgentWorker())).toBe(false)
			expect(isAgentWorker()).toBe(true)
		})
	})
})
