import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const probeTools = vi.hoisted(() => vi.fn())
const forgetMcpGrant = vi.hoisted(() => vi.fn())
const runMcpCommand = vi.hoisted(() => vi.fn())

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()
	return { ...actual, runMcpCommand }
})

vi.mock("../extensions/mcp/probe.js", () => ({
	UpstreamMcpProbe: class {
		probeTools = probeTools
	},
}))

vi.mock("./mcp-forget-grant.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./mcp-forget-grant.js")>()
	return { ...actual, forgetMcpGrant }
})

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
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("delegates unknown subcommands to pi's native MCP CLI", async () => {
		runMcpCommand.mockResolvedValue(0)
		expect(await runMcp(["login", "granola"])).toBe(0)
		expect(runMcpCommand).toHaveBeenCalledWith(["login", "granola"], expect.objectContaining({ cwd: process.cwd() }))
	})

	it("maps the adapter-era `auth` verb onto native `login`", async () => {
		runMcpCommand.mockResolvedValue(0)
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		expect(await runMcp(["auth", "granola"])).toBe(0)
		expect(runMcpCommand).toHaveBeenCalledWith(["login", "granola"], expect.objectContaining({ cwd: process.cwd() }))
		expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("kimchi mcp login")
	})

	it("delegates native-verbs (add/remove/list) to pi's MCP CLI", async () => {
		runMcpCommand.mockResolvedValue(0)
		expect(await runMcp(["list", "--json"])).toBe(0)
		expect(runMcpCommand).toHaveBeenCalledWith(["list", "--json"], expect.objectContaining({ cwd: process.cwd() }))
		expect(await runMcp(["add", "granola", "--", "npx", "granola-mcp"])).toBe(0)
		expect(runMcpCommand).toHaveBeenCalledWith(
			["add", "granola", "--", "npx", "granola-mcp"],
			expect.objectContaining({ cwd: process.cwd() }),
		)
		expect(await runMcp(["remove", "granola"])).toBe(0)
		expect(runMcpCommand).toHaveBeenCalledWith(["remove", "granola"], expect.objectContaining({ cwd: process.cwd() }))
	})

	it("prints usage when no subcommand is given", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		expect(await runMcp([])).toBe(1)
		expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("kimchi mcp probe")
	})

	it("requires JSON mode", async () => {
		const output = captureStdout()
		expect(await runMcp(["probe"])).toBe(1)
		expect(output.json.error).toContain("--json")
	})

	it.each([
		null,
		[],
		{},
		{ server: { command: "node" } },
		{ name: 42, server: { command: "node" } },
		{ name: "fixture" },
		{ name: "fixture", server: null },
		{ name: "fixture", server: "node" },
		{ name: "fixture", server: [] },
		{ name: "fixture", server: { command: "node" }, unexpected: true },
	])("rejects invalid input envelopes: %j", async (envelope) => {
		mockStdin(JSON.stringify(envelope))
		const output = captureStdout()
		expect(await runMcp(["probe", "--json"])).toBe(1)
		expect(output.json.error).toContain("Invalid probe input")
		expect(probeTools).not.toHaveBeenCalled()
	})

	it("rejects a server without a command or URL", async () => {
		mockStdin(input("fixture", {}))
		const output = captureStdout()
		expect(await runMcp(["probe", "--json"])).toBe(1)
		expect(output.json.error).toContain("must have either 'command' or 'url'")
		expect(probeTools).not.toHaveBeenCalled()
	})

	it("accepts dotted names and passes the complete server configuration through", async () => {
		const server = { command: "node", args: ["server.js"], env: { FIXTURE: "1" }, includeTools: ["lookup"] }
		mockStdin(input("github.com", server))
		captureStdout()
		expect(await runMcp(["probe", "--json"])).toBe(0)
		expect(probeTools).toHaveBeenCalledWith("github.com", server, expect.anything())
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
		{ server: { url: "https://example.test/mcp" }, error: "Probe timed out after 60 seconds" },
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

	it.each([false, true])("keeps diagnostics out of JSON and restores console methods (failure: %s)", async (fails) => {
		const originalConsole = { log: console.log, info: console.info, debug: console.debug }
		const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {})
		probeTools.mockImplementation(async () => {
			console.log("MCP Auth: authorization complete")
			console.info("MCP connection ready")
			console.debug("MCP discovery finished")
			if (fails) throw new Error("probe crashed")
			return { tools: [], needsAuth: false, error: null }
		})
		mockStdin(input())
		const output = captureStdout()

		expect(await runMcp(["probe", "--json"])).toBe(fails ? 1 : 0)
		expect(output.json).toEqual({ tools: [], needsAuth: false, error: fails ? "probe crashed" : null })
		expect(diagnostics.mock.calls).toEqual([
			["MCP Auth: authorization complete"],
			["MCP connection ready"],
			["MCP discovery finished"],
		])
		expect(console.log).toBe(originalConsole.log)
		expect(console.info).toBe(originalConsole.info)
		expect(console.debug).toBe(originalConsole.debug)
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

describe("kimchi mcp forget-grant", () => {
	beforeEach(() => {
		forgetMcpGrant.mockReset()
		forgetMcpGrant.mockReturnValue({ removed: 2 })
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("requires JSON mode", async () => {
		const output = captureStdout()
		expect(await runMcp(["forget-grant", "granola"])).toBe(1)
		expect(output.json).toEqual(expect.objectContaining({ ok: false, reason: "invalid-input" }))
		expect(forgetMcpGrant).not.toHaveBeenCalled()
	})

	it("requires exactly one server name", async () => {
		const missing = captureStdout()
		expect(await runMcp(["forget-grant", "--json"])).toBe(1)
		expect(missing.json.reason).toBe("invalid-input")
		const extra = captureStdout()
		expect(await runMcp(["forget-grant", "a", "b", "--json"])).toBe(1)
		expect(extra.json.reason).toBe("invalid-input")
		expect(forgetMcpGrant).not.toHaveBeenCalled()
	})

	it.each([
		"foo/bar",
		"foo\\bar",
		"foo..bar",
		"..",
		"--name=granola",
		"-x",
	])("rejects unsafe server name or flag %j", async (name) => {
		const output = captureStdout()
		expect(await runMcp(["forget-grant", name, "--json"])).toBe(1)
		expect(output.json.reason).toBe("invalid-input")
		expect(forgetMcpGrant).not.toHaveBeenCalled()
	})

	it("forgets the grant and reports the outcome", async () => {
		const output = captureStdout()
		expect(await runMcp(["forget-grant", "granola", "--json"])).toBe(0)
		expect(forgetMcpGrant).toHaveBeenCalledWith("granola", expect.any(String))
		expect(output.json).toEqual({ ok: true, name: "granola", removed: 2 })
	})

	it("succeeds with removed=0 when the grant is already forgotten", async () => {
		forgetMcpGrant.mockReturnValue({ removed: 0 })
		const output = captureStdout()
		expect(await runMcp(["forget-grant", "granola", "--json"])).toBe(0)
		expect(output.json).toEqual({ ok: true, name: "granola", removed: 0 })
	})

	it("reports other failures as generic errors", async () => {
		forgetMcpGrant.mockImplementation(() => {
			throw new Error("I/O exploded")
		})
		const output = captureStdout()
		expect(await runMcp(["forget-grant", "granola", "--json"])).toBe(1)
		expect(output.json).toEqual({ ok: false, name: "granola", error: "I/O exploded", reason: "error" })
	})
})
