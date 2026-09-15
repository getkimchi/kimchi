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

function mockOpenStdin(data: string): void {
	process.nextTick(() => {
		process.stdin.emit("data", data)
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
			expect.objectContaining({ authenticate: true, cwd: process.cwd() }),
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

	it.each([
		{ server: { command: "node" }, error: "Probe timed out after 15 seconds" },
		{ server: { url: "https://example.test/mcp" }, error: "Probe timed out after 60 seconds (including OAuth flow)" },
	])("reports the shared probe deadline as a CLI error: $error", async ({ server, error }) => {
		probeTools.mockResolvedValue({ tools: [], needsAuth: false, error })
		mockStdin(input("deadline", server))
		const output = captureStdout()

		expect(await runMcp(["probe", "--json"])).toBe(1)
		expect(output.json).toEqual({ tools: [], needsAuth: false, error })
	})

	it("returns an error when the upstream probe rejects", async () => {
		probeTools.mockRejectedValue(new Error("probe crashed"))
		mockStdin(input())
		const output = captureStdout()

		expect(await runMcp(["probe", "--json"])).toBe(1)
		expect(output.json).toEqual({ tools: [], needsAuth: false, error: "probe crashed" })
	})

	it("rejects interactive stdin instead of waiting for input", async () => {
		const originalIsTTY = process.stdin.isTTY
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true, writable: true })
		const output = captureStdout()

		try {
			expect(await runMcp(["probe", "--json"])).toBe(1)
			expect(output.json.error).toContain("No input on stdin")
		} finally {
			Object.defineProperty(process.stdin, "isTTY", {
				value: originalIsTTY,
				configurable: true,
				writable: true,
			})
		}
	})

	it("rejects stdin that remains open for five seconds", async () => {
		vi.useFakeTimers()
		mockOpenStdin(input())
		const output = captureStdout()
		const result = runMcp(["probe", "--json"])
		await vi.advanceTimersByTimeAsync(5_000)

		expect(await result).toBe(1)
		expect(output.json.error).toContain("Timed out after 5000ms")
	})

	it("rejects stdin larger than one megabyte", async () => {
		mockOpenStdin("x".repeat(1024 * 1024 + 1))
		const output = captureStdout()

		expect(await runMcp(["probe", "--json"])).toBe(1)
		expect(output.json.error).toContain("stdin input exceeded 1MB")
	})

	it("waits for a large stdout payload to flush before resolving", async () => {
		const tools = Array.from({ length: 5_000 }, (_, index) => ({
			name: `tool_${index}_${"x".repeat(30)}`,
			description: "y".repeat(30),
		}))
		probeTools.mockResolvedValue({ tools, needsAuth: false, error: null })
		mockStdin(input())
		let written = ""
		let finishWrite: ((error?: Error | null) => void) | undefined
		vi.spyOn(process.stdout, "write").mockImplementation(
			(
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
				callback?: (error?: Error | null) => void,
			) => {
				written += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
				finishWrite = typeof encodingOrCallback === "function" ? encodingOrCallback : callback
				return false
			},
		)

		let resolved = false
		const result = runMcp(["probe", "--json"]).then((code) => {
			resolved = true
			return code
		})
		await vi.waitFor(() => expect(finishWrite).toBeTypeOf("function"))
		expect(resolved).toBe(false)

		finishWrite?.(null)
		expect(await result).toBe(0)
		expect(JSON.parse(written)).toEqual({ tools, needsAuth: false, error: null })
	})

	it("rejects invalid JSON", async () => {
		mockStdin("not json")
		const output = captureStdout()
		expect(await runMcp(["probe", "--json"])).toBe(1)
		expect(output.json.error).toContain("Failed to parse JSON")
	})
})
