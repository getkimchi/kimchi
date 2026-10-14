import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emitExtNotification } from "./ext-notifications.js"

function makeConn(
	extNotification: (method: string, params: Record<string, unknown>) => Promise<void>,
): AgentSideConnection {
	const stub = { extNotification }
	return stub as unknown as AgentSideConnection
}

describe("emitExtNotification", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("forwards the method and params to the connection", () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = []
		const conn = makeConn(async (method, params) => {
			calls.push({ method, params })
		})

		emitExtNotification(conn, "_kimchi.dev/routed_model", { sessionId: "s1" })

		expect(calls).toEqual([{ method: "_kimchi.dev/routed_model", params: { sessionId: "s1" } }])
	})

	it("swallows a rejected delivery and logs the method to stderr", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const conn = makeConn(async () => {
			throw new Error("boom")
		})

		emitExtNotification(conn, "_kimchi.dev/routed_model", { sessionId: "s1" })
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("acp _kimchi.dev/routed_model notification failed"))
	})
})
