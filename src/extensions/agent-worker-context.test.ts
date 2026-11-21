import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import {
	getAgentWorkerParentSessionId,
	getRegisteredWorkerParentSession,
	holdAgentWorkerInactivity,
	isAgentWorker,
	registerWorkerParentSession,
	runAsAgentWorker,
	runOutsideWorkerContext,
	setAgentWorkerInactivityHold,
	setAgentWorkerParentSessionId,
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

	it("keeps each worker's explicit parent identity separate from the environment", async () => {
		process.env.KIMCHI_PARENT_SESSION_ID = "environment-owner"
		try {
			const owners = await Promise.all(
				["parent-a", "parent-b"].map((parentSessionId) =>
					runAsAgentWorker(
						async () => {
							await Promise.resolve()
							return getAgentWorkerParentSessionId()
						},
						{ parentSessionId },
					),
				),
			)
			expect(owners).toEqual(["parent-a", "parent-b"])
		} finally {
			Reflect.deleteProperty(process.env, "KIMCHI_PARENT_SESSION_ID")
		}
	})

	it("retains a worker's owner in its session for later resumes", async () => {
		const session = {} as AgentSession
		registerWorkerParentSession(session, "original-parent")
		expect(getRegisteredWorkerParentSession(session)).toBe("original-parent")
		await runAsAgentWorker(async () => {
			setAgentWorkerParentSessionId(getRegisteredWorkerParentSession(session))
			await Promise.resolve()
			expect(getAgentWorkerParentSessionId()).toBe("original-parent")
		})
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
