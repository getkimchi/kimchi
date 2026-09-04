import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const probeTools = vi.hoisted(() => vi.fn())
const verifyMcpKeyringRuntime = vi.hoisted(() => vi.fn())

vi.mock("../extensions/mcp/probe.js", () => ({
	UpstreamMcpProbe: class {
		probeTools = probeTools
	},
}))

vi.mock("../extensions/mcp/keyring-require-bridge.js", () => ({ verifyMcpKeyringRuntime }))

import { runMcp } from "./mcp.js"

function mockStdin(data: string): void {
	process.nextTick(() => {
		process.stdin.emit("data", data)
		process.stdin.emit("end")
	})
}

function captureStdout(): { readonly json: Record<string, unknown> } {
	const writes: string[] = []
	vi.spyOn(process.stdout, "write").mockImplementation(
		(
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback
			if (done) process.nextTick(() => done(null))
			return true
		},
	)
	return {
		get json() {
			return JSON.parse(writes.join("")) as Record<string, unknown>
		},
	}
}

function input(name = "fixture", server: Record<string, unknown> = { command: "node", args: ["server.js"] }): string {
	return JSON.stringify({ name, server })
}

describe("kimchi mcp probe", () => {
	beforeEach(() => {
		probeTools.mockReset()
		probeTools.mockResolvedValue({ tools: [], needsAuth: false, error: null })
		verifyMcpKeyringRuntime.mockReset()
		verifyMcpKeyringRuntime.mockReturnValue({ backend: "native", platform: "darwin", arch: "arm64", writable: true })
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("rejects unknown subcommands", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		expect(await runMcp(["unknown"])).toBe(1)
		expect(stderr).toHaveBeenCalled()
	})

	it("verifies the native keyring through the compiled-runtime bridge", async () => {
		const output = captureStdout()
		expect(await runMcp(["keyring-check", "--json"])).toBe(0)
		expect(verifyMcpKeyringRuntime).toHaveBeenCalledOnce()
		expect(output.json).toEqual({
			ok: true,
			backend: "native",
			platform: "darwin",
			arch: "arm64",
			writable: true,
		})
	})

	it("reports native keyring failures", async () => {
		verifyMcpKeyringRuntime.mockImplementation(() => {
			throw new Error("credential store unavailable")
		})
		const output = captureStdout()
		expect(await runMcp(["keyring-check", "--json"])).toBe(1)
		expect(output.json).toEqual(expect.objectContaining({ ok: false, error: "credential store unavailable" }))
	})

	it("requires JSON mode", async () => {
		const output = captureStdout()
		expect(await runMcp(["probe"])).toBe(1)
		expect(output.json.error).toContain("--json")
	})

	it("validates the input envelope and server shape", async () => {
		mockStdin(JSON.stringify({ name: "fixture", server: null }))
		const output = captureStdout()
		expect(await runMcp(["probe", "--json"])).toBe(1)
		expect(output.json.error).toContain("Invalid probe input")
	})

	it.each(["", "..", "foo/bar", "foo\\bar", "foo..bar"])("rejects unsafe server name %j", async (name) => {
		mockStdin(input(name))
		const output = captureStdout()
		expect(await runMcp(["probe", "--json"])).toBe(1)
		expect(output.json.error).toContain("Invalid probe input")
	})

	it("delegates discovery and OAuth to the isolated upstream probe", async () => {
		const server = { url: "https://example.test/mcp", auth: "oauth" }
		probeTools.mockResolvedValue({
			tools: [{ name: "lookup", description: "Look up data" }],
			needsAuth: false,
			error: null,
		})
		mockStdin(input("remote", server))
		const output = captureStdout()

		expect(await runMcp(["probe", "--json"])).toBe(0)
		expect(probeTools).toHaveBeenCalledWith(
			"remote",
			server,
			expect.objectContaining({ authenticate: true, cwd: process.cwd(), signal: expect.any(AbortSignal) }),
		)
		expect(output.json).toEqual({
			tools: [{ name: "lookup", description: "Look up data" }],
			needsAuth: false,
			error: null,
		})
	})

	it("returns authentication requirements as a successful probe", async () => {
		probeTools.mockResolvedValue({ tools: [], needsAuth: true, error: "User denied authorization" })
		mockStdin(input())
		const output = captureStdout()

		expect(await runMcp(["probe", "--json"])).toBe(0)
		expect(output.json).toEqual({ tools: [], needsAuth: true, error: "User denied authorization" })
	})

	it("returns transport failures with exit code one", async () => {
		probeTools.mockResolvedValue({ tools: [], needsAuth: false, error: "connection refused" })
		mockStdin(input())
		const output = captureStdout()

		expect(await runMcp(["probe", "--json"])).toBe(1)
		expect(output.json.error).toBe("connection refused")
	})

	it("aborts a hanging stdio probe after fifteen seconds", async () => {
		vi.useFakeTimers()
		probeTools.mockImplementation(
			(_name, _server, options: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
				}),
		)
		mockStdin(input())
		const output = captureStdout()
		const result = runMcp(["probe", "--json"])
		await vi.advanceTimersByTimeAsync(15_000)

		expect(await result).toBe(1)
		expect(output.json.error).toContain("timed out after 15 seconds")
	})

	it("rejects invalid JSON", async () => {
		mockStdin("not json")
		const output = captureStdout()
		expect(await runMcp(["probe", "--json"])).toBe(1)
		expect(output.json.error).toContain("Failed to parse JSON")
	})
})
