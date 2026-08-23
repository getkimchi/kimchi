import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — declared before imports that consume them
// ---------------------------------------------------------------------------

// Mock McpServerManager so we never spawn real subprocesses or HTTP connections.
const { mockProbeTools, mockCloseAll } = vi.hoisted(() => ({
	mockProbeTools: vi.fn(),
	mockCloseAll: vi.fn(),
}))

vi.mock("../extensions/mcp-adapter/server-manager.js", () => ({
	McpServerManager: class MockMcpServerManager {
		probeTools = mockProbeTools
		closeAll = mockCloseAll
	},
}))

// Mock the auth flow module — we control supportsOAuth and authenticate.
const { mockSupportsOAuth, mockAuthenticate } = vi.hoisted(() => ({
	mockSupportsOAuth: vi.fn(),
	mockAuthenticate: vi.fn(),
}))

vi.mock("../extensions/mcp-adapter/mcp-auth-flow.js", () => ({
	supportsOAuth: mockSupportsOAuth,
	authenticate: mockAuthenticate,
}))

// Mock the auth storage module — we control getAuthEntry / removeAuthEntry so
// the URL-mismatch guard can be exercised without touching the filesystem.
const { mockGetAuthEntry, mockRemoveAuthEntry } = vi.hoisted(() => ({
	mockGetAuthEntry: vi.fn(),
	mockRemoveAuthEntry: vi.fn(),
}))

vi.mock("../extensions/mcp-adapter/mcp-auth.js", () => ({
	getAuthEntry: mockGetAuthEntry,
	removeAuthEntry: mockRemoveAuthEntry,
}))

import { runMcp } from "./mcp.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Feed stdin data to process.stdin and emit 'end'. */
function mockStdin(data: string): void {
	const stdin = process.stdin as unknown as {
		setEncoding: (enc: string) => void
		emit: (event: string, ...args: unknown[]) => boolean
	}
	// Buffer the data, then emit 'data' and 'end' on next tick.
	process.nextTick(() => {
		stdin.emit("data", data)
		stdin.emit("end")
	})
}

/** Emit stdin data but never emit 'end' — simulates a parent that opens the
 * pipe without closing it, so readStdin would hang without the timeout. */
function mockStdinOpen(data: string): void {
	const stdin = process.stdin as unknown as {
		setEncoding: (enc: string) => void
		emit: (event: string, ...args: unknown[]) => boolean
	}
	process.nextTick(() => {
		stdin.emit("data", data)
		// Intentionally do NOT emit 'end'.
	})
}

/** Read and parse the JSON written to stdout. */
function captureStdout(): { data: string; json: Record<string, unknown> } {
	const writes: string[] = []
	vi.spyOn(process.stdout, "write").mockImplementation(
		// process.stdout.write is overloaded: (chunk, cb?) or (chunk, encoding?, cb?).
		// Accept both shapes so the mock satisfies the union type.
		(
			chunk: string | Uint8Array,
			encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
			cb?: (err?: Error | null) => void,
		) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
			const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb
			// Node's write callback is asynchronous — defer it so the emitResult
			// promise that awaits it resolves on the next tick, mirroring real I/O.
			if (callback) process.nextTick(() => callback(null))
			return true
		},
	)
	return {
		get data() {
			return writes.join("")
		},
		get json() {
			return JSON.parse(writes.join(""))
		},
	}
}

const SERVER_NAME = "my-server"
const STDIO_SERVER = { command: "node", args: ["server.js"] }
const URL_SERVER = { url: "https://example.com/mcp" }
const OAUTH_SERVER = { url: "https://example.com/mcp", auth: "oauth" as const }

/** Wrap a server entry in the { name, server } stdin contract. */
function probeInput(
	server: typeof STDIO_SERVER | typeof URL_SERVER | typeof OAUTH_SERVER | Record<string, unknown>,
	name = SERVER_NAME,
): string {
	return JSON.stringify({ name, server })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kimchi mcp probe", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCloseAll.mockResolvedValue(undefined)
		mockSupportsOAuth.mockReturnValue(false)
		// Default: no pending auth
		mockAuthenticate.mockResolvedValue("authenticated")
		// Default: no stored auth entry (new server). Individual tests override
		// this to simulate an existing entry with a same/different URL.
		mockGetAuthEntry.mockReturnValue(undefined)
		mockRemoveAuthEntry.mockReturnValue(undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// --- argument parsing -------------------------------------------------

	it("returns 1 and prints error for unknown subcommand", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const code = await runMcp(["bogus"])
		expect(code).toBe(1)
		expect(stderrSpy).toHaveBeenCalled()
	})

	it("returns 1 and emits JSON error on stdout when --json flag is missing", async () => {
		const out = captureStdout()
		const code = await runMcp(["probe"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("--json")
	})

	// --- TypeBox schema validation ------------------------------------------

	it("returns 1 when server config has neither command nor url (semantic check remains)", async () => {
		mockStdin(probeInput({}))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Server config must have either 'command' or 'url'")
	})

	it("returns 1 with JSON error when server is missing", async () => {
		mockStdin(JSON.stringify({ name: SERVER_NAME }))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Invalid probe input")
		expect(out.json.error).toContain("server")
	})

	it("returns 1 with JSON error when server is null", async () => {
		mockStdin(JSON.stringify({ name: SERVER_NAME, server: null }))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Invalid probe input")
		expect(out.json.error).toContain("object")
	})

	it("returns 1 with JSON error when server is wrong type (string)", async () => {
		mockStdin(JSON.stringify({ name: SERVER_NAME, server: "not-an-object" }))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Invalid probe input")
		expect(out.json.error).toContain("object")
	})

	it("returns 1 with JSON error when name is missing", async () => {
		mockStdin(JSON.stringify({ server: STDIO_SERVER }))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Invalid probe input")
		expect(out.json.error).toContain("name")
	})

	it("returns 1 with JSON error when name is empty", async () => {
		mockStdin(probeInput(STDIO_SERVER, ""))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Invalid probe input")
	})

	it("returns 1 when name contains path separator /", async () => {
		mockStdin(probeInput(STDIO_SERVER, "foo/bar"))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Invalid probe input")
	})

	it("returns 1 when name contains path separator backslash", async () => {
		mockStdin(probeInput(STDIO_SERVER, "foo\\bar"))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Invalid probe input")
	})

	it("returns 1 when name is .. (path traversal)", async () => {
		mockStdin(probeInput(STDIO_SERVER, ".."))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Invalid probe input")
	})

	it("returns 1 when name contains consecutive dots (foo..bar)", async () => {
		mockStdin(probeInput(STDIO_SERVER, "foo..bar"))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Invalid probe input")
	})

	it("accepts name with single dots (github.com)", async () => {
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: false })
		mockStdin(probeInput(STDIO_SERVER, "github.com"))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json.error).toBeNull()
		expect(mockProbeTools).toHaveBeenCalledWith("github.com", STDIO_SERVER)
	})

	it("returns 1 when unknown top-level properties are present", async () => {
		mockStdin(JSON.stringify({ name: SERVER_NAME, server: STDIO_SERVER, extra: true }))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Invalid probe input")
	})

	it("accepts server with additionalProperties (full ServerEntry shape)", async () => {
		const fullServer = { command: "npx", args: ["-y", "server.js"], env: { FOO: "bar" }, cwd: "/tmp", debug: true }
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: false })
		mockStdin(probeInput(fullServer))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json.error).toBeNull()
	})

	it("returns exit code 1 with JSON error for all validation failures", async () => {
		// Verify error envelope shape for a validation failure
		mockStdin(JSON.stringify({ name: SERVER_NAME, server: null }))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json).toEqual({
			tools: [],
			needsAuth: false,
			error: expect.stringContaining("Invalid probe input"),
		})
	})

	// --- readStdin guards: TTY, timeout, size cap --------------------------

	it("returns 1 when stdin is a TTY", async () => {
		// Simulate an interactive launch with no piped input.
		Object.defineProperty(process.stdin, "isTTY", {
			value: true,
			configurable: true,
			writable: true,
		})
		const out = captureStdout()
		try {
			const code = await runMcp(["probe", "--json"])
			expect(code).toBe(1)
			expect(out.json.error).toContain("No input on stdin")
		} finally {
			// Restore the non-TTY default so subsequent tests see no piped TTY.
			;(process.stdin as { isTTY?: boolean }).isTTY = undefined
		}
	})

	it("returns 1 when stdin input times out", async () => {
		vi.useFakeTimers()
		try {
			// Emit data but never 'end' — readStdin would hang without the timeout.
			mockStdinOpen(probeInput(STDIO_SERVER))
			const out = captureStdout()

			const probePromise = runMcp(["probe", "--json"])
			await vi.advanceTimersByTimeAsync(5000)
			const code = await probePromise

			expect(code).toBe(1)
			expect(out.json.error).toContain("Timed out after 5000ms")
		} finally {
			vi.useRealTimers()
		}
	})

	it("returns 1 when stdin input exceeds 1MB", async () => {
		// Build a payload larger than 1MB. The first chunk alone crosses the cap.
		const big = JSON.stringify({ name: SERVER_NAME, server: STDIO_SERVER, padding: "x".repeat(1_050_000) })
		mockStdinOpen(big)
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("stdin input exceeded 1MB")
	})

	// --- successful stdio probe -------------------------------------------

	it("connects, lists tools, and prints JSON for a stdio server", async () => {
		mockProbeTools.mockResolvedValue({
			tools: [
				{ name: "tool_a", title: "Tool A", description: "Does A" },
				{ name: "tool_b", description: "Does B" },
			],
			needsAuth: false,
		})
		mockStdin(probeInput(STDIO_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json).toEqual({
			tools: [
				{ name: "tool_a", title: "Tool A", description: "Does A" },
				{ name: "tool_b", title: undefined, description: "Does B" },
			],
			needsAuth: false,
			error: null,
		})
		expect(mockProbeTools).toHaveBeenCalledTimes(1)
		expect(mockProbeTools).toHaveBeenCalledWith(SERVER_NAME, STDIO_SERVER)
		expect(mockCloseAll).toHaveBeenCalledTimes(1)
	})

	// --- needsAuth without OAuth (returns needsAuth: true) ----------------

	it("returns needsAuth: true when server needs auth but OAuth is not supported", async () => {
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: true })
		mockSupportsOAuth.mockReturnValue(false)
		mockStdin(probeInput(URL_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json).toEqual({ tools: [], needsAuth: true, error: null })
		expect(mockAuthenticate).not.toHaveBeenCalled()
	})

	// --- OAuth flow: auth succeeds, retries probe --------------------------

	it("attempts OAuth flow and retries probe when needsAuth + OAuth supported", async () => {
		mockSupportsOAuth.mockReturnValue(true)
		mockAuthenticate.mockResolvedValue("authenticated")

		// First probe returns needsAuth, second probe (after auth) returns tools
		mockProbeTools
			.mockResolvedValueOnce({ tools: [], needsAuth: true })
			.mockResolvedValueOnce({ tools: [{ name: "secure_tool" }], needsAuth: false })

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(mockAuthenticate).toHaveBeenCalledTimes(1)
		expect(mockAuthenticate).toHaveBeenCalledWith(SERVER_NAME, OAUTH_SERVER.url, OAUTH_SERVER)
		expect(mockProbeTools).toHaveBeenCalledTimes(2)
		expect(mockProbeTools).toHaveBeenNthCalledWith(1, SERVER_NAME, OAUTH_SERVER)
		expect(mockProbeTools).toHaveBeenNthCalledWith(2, SERVER_NAME, OAUTH_SERVER)
		expect(out.json).toEqual({
			tools: [{ name: "secure_tool", title: undefined, description: undefined }],
			needsAuth: false,
			error: null,
		})
	})

	// --- repeat probe: tokens already exist, OAuth is skipped -------------

	it("skips OAuth when the first probe returns tools (tokens already exist)", async () => {
		mockSupportsOAuth.mockReturnValue(true)
		// First probe returns tools directly — stored tokens were found.
		mockProbeTools.mockResolvedValue({
			tools: [{ name: "secure_tool" }],
			needsAuth: false,
		})

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(mockProbeTools).toHaveBeenCalledTimes(1)
		expect(mockProbeTools).toHaveBeenCalledWith(SERVER_NAME, OAUTH_SERVER)
		expect(mockAuthenticate).not.toHaveBeenCalled()
		expect(out.json).toEqual({
			tools: [{ name: "secure_tool", title: undefined, description: undefined }],
			needsAuth: false,
			error: null,
		})
	})

	// --- OAuth flow: auth fails, returns needsAuth: true ------------------

	it("returns needsAuth: true with error message when OAuth flow fails", async () => {
		mockSupportsOAuth.mockReturnValue(true)
		mockAuthenticate.mockRejectedValue(new Error("user denied"))

		// Auth fails immediately — no retry probe should happen.
		mockProbeTools.mockResolvedValueOnce({ tools: [], needsAuth: true })

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(mockAuthenticate).toHaveBeenCalledTimes(1)
		expect(mockProbeTools).toHaveBeenCalledTimes(1)
		expect(out.json).toEqual({ tools: [], needsAuth: true, error: "user denied" })
	})

	it("returns needsAuth: true with real error when OAuth fails with port-in-use message", async () => {
		mockSupportsOAuth.mockReturnValue(true)
		const oauthError = "port 19876 is held by another process"
		mockAuthenticate.mockRejectedValue(new Error(oauthError))
		mockProbeTools.mockResolvedValueOnce({ tools: [], needsAuth: true })

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json.needsAuth).toBe(true)
		expect(out.json.error).toContain(oauthError)
	})

	// --- OAuth flow: auth times out, returns needsAuth: true --------------

	it("returns needsAuth: true with timeout message when OAuth flow times out", async () => {
		vi.useFakeTimers()
		try {
			mockSupportsOAuth.mockReturnValue(true)
			// authenticate never resolves — simulates user walking away
			mockAuthenticate.mockReturnValue(new Promise(() => {}))
			mockProbeTools.mockResolvedValueOnce({ tools: [], needsAuth: true })

			mockStdin(probeInput(OAUTH_SERVER))
			const out = captureStdout()

			const probePromise = runMcp(["probe", "--json"])
			// Advance past the 60s OAuth timeout
			await vi.advanceTimersByTimeAsync(60_000)
			const code = await probePromise

			expect(code).toBe(0)
			expect(out.json).toEqual({ tools: [], needsAuth: true, error: "OAuth flow timed out" })
		} finally {
			vi.useRealTimers()
		}
	})

	it("returns exit code 1 when non-OAuth server times out", async () => {
		vi.useFakeTimers()
		try {
			mockSupportsOAuth.mockReturnValue(false)
			// probeTools never resolves — simulates server hanging
			mockProbeTools.mockReturnValue(new Promise(() => {}))

			mockStdin(probeInput(STDIO_SERVER))
			const out = captureStdout()

			const probePromise = runMcp(["probe", "--json"])
			// Advance past the 15s non-OAuth timeout
			await vi.advanceTimersByTimeAsync(15_000)
			const code = await probePromise

			expect(code).toBe(1)
			expect(out.json.needsAuth).toBe(false)
			expect(out.json.error).toContain("timed out")
		} finally {
			vi.useRealTimers()
		}
	})

	// --- error handling ---------------------------------------------------

	it("returns exit code 1 with error JSON when probe throws", async () => {
		mockProbeTools.mockRejectedValue(new Error("connection refused"))
		mockStdin(probeInput(STDIO_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json).toEqual({
			tools: [],
			needsAuth: false,
			error: "connection refused",
		})
		expect(mockCloseAll).toHaveBeenCalledTimes(1)
	})

	it("returns exit code 1 when stdin is not valid JSON", async () => {
		mockStdin("not json {{{")
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json.error).toContain("Failed to parse JSON")
	})

	// --- cleanup ----------------------------------------------------------

	it("always calls closeAll in the finally block", async () => {
		mockProbeTools.mockRejectedValue(new Error("boom"))
		mockStdin(probeInput(STDIO_SERVER))

		await runMcp(["probe", "--json"])
		expect(mockCloseAll).toHaveBeenCalledTimes(1)
	})

	// --- stdout flush ------------------------------------------------------

	it("awaits the stdout write callback before resolving (large payload >64KB is not truncated)", async () => {
		// Generate a payload well above the ~64KB pipe buffer: 5000 tool objects
		// with long names. If emitResult didn't await the write callback, a
		// subsequent process.exit() could truncate the output mid-stream.
		const bigTools = Array.from({ length: 5000 }, (_, i) => ({
			name: `tool_${String(i).padStart(6, "0")}_${"x".repeat(30)}`,
			description: "y".repeat(30),
		}))
		mockProbeTools.mockResolvedValue({ tools: bigTools, needsAuth: false })

		mockStdin(probeInput(STDIO_SERVER))
		const out = captureStdout()
		const code = await runMcp(["probe", "--json"])

		expect(code).toBe(0)
		// Parse the captured stdout and verify the full payload survived.
		const parsed = out.json as {
			tools: Array<{ name: string; description: string }>
			needsAuth: boolean
			error: string | null
		}
		expect(parsed.tools).toHaveLength(5000)
		expect(parsed.tools[0].name).toBe(bigTools[0].name)
		expect(parsed.tools[4999].name).toBe(bigTools[4999].name)
		expect(parsed.tools[4999].description).toBe(bigTools[4999].description)
		expect(parsed.needsAuth).toBe(false)
		expect(parsed.error).toBeNull()
	})

	// --- inline-error routing (probeTools no longer throws) ------------

	// After the merge, probeTools returns connect/tool errors inline via
	// `result.error` instead of throwing. The CLI must still surface those as
	// exit-1 failures so the UI can display them (preserving the pre-unification
	// contract where a connection failure was a thrown error).
	it("surfaces a probeTools inline error as exit code 1 without throwing", async () => {
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: false, error: "Connection refused" })
		mockStdin(probeInput(STDIO_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(1)
		expect(out.json).toEqual({ tools: [], needsAuth: false, error: "Connection refused" })
		expect(mockCloseAll).toHaveBeenCalledTimes(1)
	})

	// --- URL mismatch guard (OAuth token store key) ----------------------

	it("uses the real name and does not clean up when an auth entry with a matching URL exists", async () => {
		// Existing entry stored for the same URL → repeat probe of an authorized
		// server. The guard should reuse the real name so stored tokens are found
		// and OAuth is skipped.
		mockGetAuthEntry.mockReturnValue({ serverUrl: OAUTH_SERVER.url, tokens: { accessToken: "tok" } })
		mockSupportsOAuth.mockReturnValue(true)
		mockProbeTools.mockResolvedValue({ tools: [{ name: "secure_tool" }], needsAuth: false })

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json.error).toBeNull()
		// Real name used for both probe and (not invoked) auth.
		expect(mockProbeTools).toHaveBeenCalledWith(SERVER_NAME, OAUTH_SERVER)
		expect(mockAuthenticate).not.toHaveBeenCalled()
		// No cleanup — real credentials must survive the probe.
		expect(mockRemoveAuthEntry).not.toHaveBeenCalled()
	})

	it("uses a throwaway name and cleans it up when an auth entry with a different URL exists", async () => {
		// The user edited the server's URL but kept the name. A stored entry
		// exists under the real name for a DIFFERENT URL — probing with the real
		// name would overwrite the real server's tokens.
		mockGetAuthEntry.mockReturnValue({ serverUrl: "https://old.example.com/mcp", tokens: { accessToken: "tok" } })
		mockSupportsOAuth.mockReturnValue(true)
		// First probe needs auth; after auth, retry returns tools.
		mockProbeTools
			.mockResolvedValueOnce({ tools: [], needsAuth: true })
			.mockResolvedValueOnce({ tools: [{ name: "secure_tool" }], needsAuth: false })

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json.error).toBeNull()

		// Both probeTools calls and authenticate received the throwaway name.
		const firstCallArg = mockProbeTools.mock.calls[0]?.[0]
		const secondCallArg = mockProbeTools.mock.calls[1]?.[0]
		const authNameArg = mockAuthenticate.mock.calls[0]?.[0]
		expect(firstCallArg).toMatch(/^__probe_[0-9a-f-]{36}$/)
		expect(secondCallArg).toBe(firstCallArg)
		expect(authNameArg).toBe(firstCallArg)
		// The real name was never used as the token-store key.
		expect(mockProbeTools).not.toHaveBeenCalledWith(SERVER_NAME, OAUTH_SERVER)
		expect(mockAuthenticate).not.toHaveBeenCalledWith(SERVER_NAME, OAUTH_SERVER.url, OAUTH_SERVER)
		// Throwaway credentials cleaned up in the finally block.
		expect(mockRemoveAuthEntry).toHaveBeenCalledTimes(1)
		expect(mockRemoveAuthEntry).toHaveBeenCalledWith(firstCallArg)
	})

	it("uses the real name and does not clean up when no auth entry exists (new server)", async () => {
		// No stored entry → new server. The guard should use the real name so the
		// first probe persists tokens under it and a repeat probe finds them.
		mockGetAuthEntry.mockReturnValue(undefined)
		mockSupportsOAuth.mockReturnValue(true)
		mockProbeTools.mockResolvedValue({ tools: [], needsAuth: false })

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json.error).toBeNull()
		expect(mockProbeTools).toHaveBeenCalledWith(SERVER_NAME, OAUTH_SERVER)
		expect(mockRemoveAuthEntry).not.toHaveBeenCalled()
	})

	it("does not overwrite the real server's tokens when probing an edited URL (entry for a different URL)", async () => {
		// Scenario: editing a server's URL and probing it must NOT overwrite the
		// real server's stored tokens. A throwaway name isolates the probe's
		// credentials, and removeAuthEntry wipes them afterwards.
		const realUrl = "https://old.example.com/mcp"
		mockGetAuthEntry.mockReturnValue({ serverUrl: realUrl, tokens: { accessToken: "real-tok" } })
		mockSupportsOAuth.mockReturnValue(true)
		// Probe needs auth, OAuth succeeds, retry returns tools.
		mockProbeTools
			.mockResolvedValueOnce({ tools: [], needsAuth: true })
			.mockResolvedValueOnce({ tools: [{ name: "secure_tool" }], needsAuth: false })

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json.error).toBeNull()

		// The real name (SERVER_NAME) was never passed as the token-store key.
		const probeNames = mockProbeTools.mock.calls.map((c) => c[0])
		expect(probeNames).not.toContain(SERVER_NAME)
		expect(mockAuthenticate).not.toHaveBeenCalledWith(SERVER_NAME, OAUTH_SERVER.url, OAUTH_SERVER)
		// Throwaway name was cleaned up exactly once.
		expect(mockRemoveAuthEntry).toHaveBeenCalledTimes(1)
		expect(mockRemoveAuthEntry.mock.calls[0]?.[0]).not.toBe(SERVER_NAME)
	})

	it("reuses the real name and skips OAuth on a repeat probe of an unchanged authorized server", async () => {
		// A repeat probe of an unchanged, authorized server: the stored entry's
		// URL matches, so the real name is used and the first probe finds the
		// stored tokens — authenticate() is never called.
		mockGetAuthEntry.mockReturnValue({ serverUrl: OAUTH_SERVER.url, tokens: { accessToken: "tok" } })
		mockSupportsOAuth.mockReturnValue(true)
		mockProbeTools.mockResolvedValue({ tools: [{ name: "secure_tool" }], needsAuth: false })

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(mockProbeTools).toHaveBeenCalledTimes(1)
		expect(mockProbeTools).toHaveBeenCalledWith(SERVER_NAME, OAUTH_SERVER)
		expect(mockAuthenticate).not.toHaveBeenCalled()
		expect(mockRemoveAuthEntry).not.toHaveBeenCalled()
		expect(out.json).toEqual({
			tools: [{ name: "secure_tool", title: undefined, description: undefined }],
			needsAuth: false,
			error: null,
		})
	})

	it("uses the real name and does not clean up when the entry is from an incomplete OAuth flow", async () => {
		// An OAuth flow that was started but never finished leaves an entry
		// with only oauthState/codeVerifier — no serverUrl. Treating it as a
		// URL mismatch would probe under a throwaway name whose OAuth tokens
		// the finally block then deletes, leaving every subsequent probe with
		// needsAuth: true. The real name must be reused so the flow can
		// complete on the correct entry.
		mockGetAuthEntry.mockReturnValue({ oauthState: "state-123" })
		mockSupportsOAuth.mockReturnValue(true)
		mockProbeTools.mockResolvedValue({ tools: [{ name: "secure_tool" }], needsAuth: false })

		mockStdin(probeInput(OAUTH_SERVER))
		const out = captureStdout()

		const code = await runMcp(["probe", "--json"])
		expect(code).toBe(0)
		expect(out.json.error).toBeNull()
		expect(mockProbeTools).toHaveBeenCalledWith(SERVER_NAME, OAUTH_SERVER)
		expect(mockRemoveAuthEntry).not.toHaveBeenCalled()
	})
})
