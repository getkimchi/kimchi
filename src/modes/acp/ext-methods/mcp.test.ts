import type { ServerEntry } from "pi-mcp-adapter/types"
import { describe, expect, it, vi } from "vitest"
import type { McpProbe, ProbeResult } from "../../../extensions/mcp/probe.js"
import { handleProbeMcpServer, validateServerEntry } from "./mcp.js"

function createProbe(result: ProbeResult): McpProbe {
	return { probeTools: vi.fn().mockResolvedValue(result) }
}

describe("validateServerEntry", () => {
	it("accepts validated stdio and HTTP definitions", () => {
		expect(validateServerEntry({ command: "node", args: ["server.js"], env: { TOKEN: "value" } })).toEqual({
			command: "node",
			args: ["server.js"],
			env: { TOKEN: "value" },
		})
		expect(
			validateServerEntry({ url: "https://example.test/mcp", headers: { Authorization: "Bearer value" } }),
		).toEqual({
			url: "https://example.test/mcp",
			headers: { Authorization: "Bearer value" },
		})
	})

	it.each([null, undefined, "string", 123, []])("rejects non-object definition %j", (server) => {
		expect(() => validateServerEntry(server)).toThrow(expect.objectContaining({ code: -32602 }))
	})

	it("rejects missing transports and malformed optional fields", () => {
		expect(() => validateServerEntry({})).toThrow("must have a 'command' or 'url' field")
		expect(() => validateServerEntry({ command: "node", args: [123] })).toThrow("array of strings")
		expect(() => validateServerEntry({ command: "node", env: { TOKEN: 123 } })).toThrow("must be a string")
		expect(() => validateServerEntry({ url: "https://example.test", headers: "bad" })).toThrow(
			"'server.headers' must be an object",
		)
		expect(() => validateServerEntry({ url: "https://example.test", auth: "basic" })).toThrow(
			"must be 'oauth', 'bearer', or false",
		)
	})
})

describe("handleProbeMcpServer", () => {
	const server: ServerEntry = { command: "node", args: ["server.js"] }
	const result: ProbeResult = {
		tools: [{ name: "read_file", description: "Read a file" }],
		needsAuth: false,
		error: null,
	}

	it("delegates to the isolated probe with authentication enabled", async () => {
		const probe = createProbe(result)
		expect(await handleProbeMcpServer(probe, { server, serverName: "fixture" })).toEqual(result)
		expect(probe.probeTools).toHaveBeenCalledWith("fixture", server, { authenticate: true })
	})

	it("supports auth-free discovery and the default probe name", async () => {
		const probe = createProbe(result)
		await handleProbeMcpServer(probe, { server, skipAuth: true })
		expect(probe.probeTools).toHaveBeenCalledWith("probe", server, { authenticate: false })
	})

	it("rejects unavailable probes and missing server parameters", async () => {
		await expect(handleProbeMcpServer(undefined, { server })).rejects.toThrow("MCP probe is not available")
		await expect(handleProbeMcpServer(createProbe(result), {})).rejects.toMatchObject({ code: -32602 })
	})

	it("serializes concurrent calls FIFO with no overlap", async () => {
		let active = 0
		let maxActive = 0
		const order: string[] = []
		const gates: Array<() => void> = []
		const probe: McpProbe = {
			probeTools: vi.fn(async (name: string) => {
				order.push(`start:${name}`)
				active += 1
				maxActive = Math.max(maxActive, active)
				await new Promise<void>((resolve) => gates.push(resolve))
				active -= 1
				order.push(`end:${name}`)
				if (name === "second") throw new Error("boom")
				return result
			}),
		}

		// The second probe fails, verifying the chain survives rejections.
		const first = handleProbeMcpServer(probe, { server, serverName: "first", skipAuth: true })
		const second = handleProbeMcpServer(probe, { server, serverName: "second", skipAuth: true })
		const third = handleProbeMcpServer(probe, { server, serverName: "third" })
		// Attach rejection handlers up front to avoid an unhandled rejection.
		const secondRejection = expect(second).rejects.toThrow("boom")

		// Let microtasks flush; only the first probe may have started.
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(probe.probeTools).toHaveBeenCalledTimes(1)
		expect(probe.probeTools).toHaveBeenNthCalledWith(1, "first", server, { authenticate: false })

		// FIFO: releasing the first starts exactly the second, never the third.
		gates[0]?.()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(probe.probeTools).toHaveBeenCalledTimes(2)
		expect(probe.probeTools).toHaveBeenNthCalledWith(2, "second", server, { authenticate: false })

		gates[1]?.()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(probe.probeTools).toHaveBeenCalledTimes(3)
		expect(probe.probeTools).toHaveBeenNthCalledWith(3, "third", server, { authenticate: true })

		gates[2]?.()
		await Promise.all([expect(first).resolves.toEqual(result), expect(third).resolves.toEqual(result)])
		await secondRejection
		expect(maxActive).toBe(1)
		expect(order).toEqual(["start:first", "end:first", "start:second", "end:second", "start:third", "end:third"])
	})

	it("queues later probes behind a slow interactive probe and keeps the result shape", async () => {
		const probe = createProbe(result)
		let release!: () => void
		const slow = new Promise<void>((resolve) => {
			release = resolve
		})
		vi.mocked(probe.probeTools).mockImplementationOnce(async () => {
			await slow
			return result
		})

		const interactive = handleProbeMcpServer(probe, { server, serverName: "interactive" })
		const queued = handleProbeMcpServer(probe, { server, serverName: "queued", skipAuth: true })
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(probe.probeTools).toHaveBeenCalledTimes(1)

		release()
		await expect(interactive).resolves.toEqual(result)
		await expect(queued).resolves.toEqual(result)
		expect(probe.probeTools).toHaveBeenCalledTimes(2)
	})
})
