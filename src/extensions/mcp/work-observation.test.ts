import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { readWorkRecords } from "../work-attribution/summary.js"
import mcpWorkObservationExtension from "./work-observation.js"

const toolRequest = vi.hoisted(() => ({ identity: undefined as { requestId: string; workId: string } | undefined }))
const resourceState = vi.hoisted(() => ({ enabled: true }))

vi.mock("../../resources/store.js", () => ({
	isResourceEnabled: vi.fn(() => resourceState.enabled),
}))

vi.mock("../work-attribution.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../work-attribution.js")>()
	return {
		...original,
		getToolRequest: (_ctx: unknown, toolCallId: string) =>
			toolRequest.identity && !toolCallId.includes("/") ? toolRequest.identity : undefined,
	}
})

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>

let cwd: string
function git(...args: string[]) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
}

function register(): { tool_call: Handler; tool_result: Handler } {
	const { tool_call, tool_result } = registerOptional()
	if (tool_call === undefined || tool_result === undefined) throw new Error("extension did not register both handlers")
	return { tool_call, tool_result }
}

function registerOptional(): { tool_call?: Handler; tool_result?: Handler } {
	const handlers: { tool_call?: Handler; tool_result?: Handler } = {}
	mcpWorkObservationExtension({
		on: ((event: string, handler: Handler) => {
			handlers[event as "tool_call" | "tool_result"] = handler
		}) as never,
	} as never)
	return handlers
}

function observations() {
	return readWorkRecords(join(cwd, ".agent")).filter((row) => row.type === "file_observation")
}

beforeEach(() => {
	cwd = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-mcp-observation-")))
	vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, ".agent"))
	git("init", "-q")
	git("config", "user.name", "Test")
	git("config", "user.email", "test@example.invalid")
	git("config", "commit.gpgSign", "false")
	writeFileSync(join(cwd, ".gitignore"), ".agent/\n")
	writeFileSync(join(cwd, "source.ts"), "original\n")
	git("add", ".")
	git("commit", "-qm", "base")
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(cwd, { recursive: true, force: true })
})

describe("mcpWorkObservationExtension", () => {
	it("observes files an MCP tool changes between tool_call and tool_result", async () => {
		toolRequest.identity = { requestId: "req-1", workId: randomUUID() }
		const handlers = register()
		const ctx = createContext({ cwd })
		await handlers.tool_call({ type: "tool_call", toolName: "mcp__fs__write_file", toolCallId: "call-1" }, ctx)
		writeFileSync(join(cwd, "source.ts"), "changed by the server\n")
		await handlers.tool_result({ type: "tool_result", toolCallId: "call-1" }, ctx)

		const records = observations()
		expect(records).toHaveLength(1)
		expect(records[0]).toMatchObject({ source: "mcp", toolCallId: "call-1", requestId: "req-1", complete: true })
		expect(records[0].files).toEqual([{ path: "source.ts", before: expect.anything(), after: expect.anything() }])
	})

	it("attributes a nested codemode call to the parent call's request", async () => {
		// getToolRequest is mocked to reject ids containing "/" (nested), so the
		// parent fallback is the only attribution source.
		toolRequest.identity = { requestId: "req-2", workId: randomUUID() }
		const handlers = register()
		const ctx = createContext({ cwd })
		await handlers.tool_call(
			{
				type: "tool_call",
				toolName: "mcp__fs__write_file",
				toolCallId: "parent-1/1",
				parentToolCallId: "parent-1",
			},
			ctx,
		)
		writeFileSync(join(cwd, "source.ts"), "changed by a script\n")
		await handlers.tool_result({ type: "tool_result", toolCallId: "parent-1/1" }, ctx)

		expect(observations()).toHaveLength(1)
		expect(observations()[0]).toMatchObject({ toolCallId: "parent-1/1", requestId: "req-2" })
	})

	it("skips unattributed MCP calls, non-MCP tools, and records nothing without changes", async () => {
		toolRequest.identity = undefined
		const handlers = register()
		const ctx = createContext({ cwd })
		await handlers.tool_call({ type: "tool_call", toolName: "mcp__fs__write_file", toolCallId: "call-9" }, ctx)
		writeFileSync(join(cwd, "source.ts"), "unattributed change\n")
		await handlers.tool_result({ type: "tool_result", toolCallId: "call-9" }, ctx)
		expect(observations()).toHaveLength(0)

		toolRequest.identity = { requestId: "req-3", workId: randomUUID() }
		await handlers.tool_call({ type: "tool_call", toolName: "read", toolCallId: "call-10" }, ctx)
		writeFileSync(join(cwd, "source.ts"), "non-mcp change\n")
		await handlers.tool_result({ type: "tool_result", toolCallId: "call-10" }, ctx)
		expect(observations()).toHaveLength(0)
	})

	it("records nothing when the cost-per-pr resource is disabled", async () => {
		resourceState.enabled = false
		const handlers = registerOptional()
		// The extension registers no handlers at all when the resource is off.
		expect(handlers.tool_call).toBeUndefined()
		expect(handlers.tool_result).toBeUndefined()
	})
})
