import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../project-scope-trust.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { renderSystemPromptBlocks } from "../prompt-construction/system-prompt-blocks.js"
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../steer-marker.js"
import agentsRulesExtension, { AGENTS_RULE_BODY_TYPE } from "./index.js"

const SESSION_PREFIX = "agents-rules-smoke-"
let SESSION_ID = `${SESSION_PREFIX}0`

let dir: string
let oldCwd: string

function makeCtx(): ExtensionContext {
	return {
		cwd: dir,
		sessionManager: { getSessionId: () => SESSION_ID },
	} as unknown as ExtensionContext
}

function writeRule(name: string, frontmatter: string, body: string): void {
	const rulesDir = join(dir, ".agents", "rules")
	mkdirSync(rulesDir, { recursive: true })
	writeFileSync(join(rulesDir, name), `---\n${frontmatter}\n---\n${body}\n`)
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-agents-rules-wiring-"))
	oldCwd = process.cwd()
	// Unique session per test: renderSystemPromptBlocks renders blocks from
	// every pi bound to the session id, and module state persists across tests
	// within this file — a shared id would leak earlier tests' blocks.
	SESSION_ID = `${SESSION_PREFIX}${Math.random().toString(36).slice(2)}`
	// Default the temp cwd to trusted; the trust-gate test opts out.
	resetProjectScopeTrustForTests()
	setProjectScopeTrusted(dir, true)
})

afterEach(() => {
	process.chdir(oldCwd)
	rmSync(dir, { recursive: true, force: true })
})

describe("agents-rules extension wiring", () => {
	it("registers handlers without touching the filesystem until session_start", () => {
		const mock = createExtensionApi()
		agentsRulesExtension(mock.api)
		// No discovery before a session exists.
		expect(mock.sendMessage).not.toHaveBeenCalled()
	})

	it("renders always-apply bodies and the available index in the system prompt block", async () => {
		writeRule("always.mdc", "description: baseline\nalwaysApply: true", "ALWAYS BODY CONTENT")
		writeRule("onfile.mdc", 'description: api\nglobs: "src/api/**"', "GLOB BODY CONTENT")
		writeRule("ondemand.mdc", "description: read me when relevant", "AVAILABLE BODY")

		const mock = createExtensionApi()
		agentsRulesExtension(mock.api)
		await mock.emit("session_start", { type: "session_start" }, makeCtx())

		const blocks = renderSystemPromptBlocks(SESSION_ID, { mode: "single" })
		const text = blocks.map((b) => b.content).join("\n")
		expect(text).toContain("## Rules")
		expect(text).toContain("ALWAYS BODY CONTENT")
		expect(text).toContain("### Available rules")
		expect(text).toContain("ondemand")
		expect(text).toContain("read me when relevant")
		// Glob bodies never render into the prompt — steer-only delivery.
		expect(text).not.toContain("GLOB BODY CONTENT")
	})

	it("renders nothing when no rules exist", async () => {
		const mock = createExtensionApi()
		agentsRulesExtension(mock.api)
		await mock.emit("session_start", { type: "session_start" }, makeCtx())

		const blocks = renderSystemPromptBlocks(SESSION_ID, { mode: "single" })
		expect(blocks.filter((b) => b.owner === "agents-rules")).toEqual([])
	})

	it("steers a glob rule on the tool_result after a matching tool_call", async () => {
		writeRule("onfile.mdc", 'globs: "src/api/**"', "GLOB BODY CONTENT")

		const mock = createExtensionApi()
		agentsRulesExtension(mock.api)
		await mock.emit("session_start", { type: "session_start" }, makeCtx())

		await mock.emit(
			"tool_call",
			{ type: "tool_call", toolName: "edit", input: { path: join(dir, "src/api/x.ts") } },
			makeCtx(),
		)
		// Steer waits for the tool result — same-turn delivery before next inference.
		expect(mock.sendMessage).not.toHaveBeenCalled()

		await mock.emit("tool_result", { type: "tool_result" }, makeCtx())
		expect(mock.sendMessage).toHaveBeenCalledTimes(1)
		expect(mock.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: AGENTS_RULE_BODY_TYPE,
				content: `${SYSTEM_REMINDER_OPEN}GLOB BODY CONTENT${SYSTEM_REMINDER_CLOSE}`,
				display: false,
				details: { name: "onfile" },
			}),
			{ deliverAs: "steer" },
		)
	})

	it("steers a glob rule exactly once per session across repeated matching calls", async () => {
		writeRule("onfile.mdc", 'globs: "src/api/**"', "GLOB BODY")

		const mock = createExtensionApi()
		agentsRulesExtension(mock.api)
		await mock.emit("session_start", { type: "session_start" }, makeCtx())

		for (const path of ["src/api/a.ts", "src/api/b.ts", "src/api/c.ts"]) {
			await mock.emit("tool_call", { type: "tool_call", toolName: "read", input: { path: join(dir, path) } }, makeCtx())
			await mock.emit("tool_result", { type: "tool_result" }, makeCtx())
		}
		expect(mock.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("does not steer on non-matching tool calls", async () => {
		writeRule("onfile.mdc", 'globs: "src/api/**"', "GLOB BODY")

		const mock = createExtensionApi()
		agentsRulesExtension(mock.api)
		await mock.emit("session_start", { type: "session_start" }, makeCtx())

		await mock.emit(
			"tool_call",
			{ type: "tool_call", toolName: "edit", input: { path: join(dir, "docs/readme.md") } },
			makeCtx(),
		)
		await mock.emit("tool_result", { type: "tool_result" }, makeCtx())
		await mock.emit(
			"tool_call",
			{ type: "tool_call", toolName: "bash", input: { command: "cat src/api/x.ts" } },
			makeCtx(),
		)
		await mock.emit("tool_result", { type: "tool_result" }, makeCtx())
		expect(mock.sendMessage).not.toHaveBeenCalled()
	})

	it("re-steers activated rules after compaction with a compaction reason", async () => {
		writeRule("onfile.mdc", 'globs: "src/api/**"', "GLOB BODY")

		const mock = createExtensionApi()
		agentsRulesExtension(mock.api)
		await mock.emit("session_start", { type: "session_start" }, makeCtx())
		await mock.emit(
			"tool_call",
			{ type: "tool_call", toolName: "read", input: { path: join(dir, "src/api/a.ts") } },
			makeCtx(),
		)
		await mock.emit("tool_result", { type: "tool_result" }, makeCtx())
		expect(mock.sendMessage).toHaveBeenCalledTimes(1)

		// Synthetic compaction event without a readable branch: the survival
		// check falls back to re-steering (delivery guarantee over dedup).
		await mock.emit("session_compact", { type: "session_compact", reason: "manual" }, {
			cwd: dir,
			sessionManager: { getSessionId: () => SESSION_ID },
		} as unknown as ExtensionContext)
		expect(mock.sendMessage).toHaveBeenCalledTimes(2)
		expect(mock.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				customType: AGENTS_RULE_BODY_TYPE,
				details: { name: "onfile", reason: "compaction" },
			}),
			{ deliverAs: "steer" },
		)
	})

	it("rediscovers rules when session_start re-fires (rule added between sessions)", async () => {
		writeRule("always.mdc", "alwaysApply: true", "FIRST RULE")

		const mock = createExtensionApi()
		agentsRulesExtension(mock.api)
		await mock.emit("session_start", { type: "session_start" }, makeCtx())
		let blocks = renderSystemPromptBlocks(SESSION_ID, { mode: "single" })
		expect(blocks.map((b) => b.content).join("\n")).toContain("FIRST RULE")

		writeRule("always2.mdc", "alwaysApply: true", "SECOND RULE")
		await mock.emit("session_start", { type: "session_start" }, makeCtx())
		blocks = renderSystemPromptBlocks(SESSION_ID, { mode: "single" })
		expect(blocks.map((b) => b.content).join("\n")).toContain("SECOND RULE")
	})

	it("loads no rules, block or steers while the cwd is untrusted", async () => {
		writeRule("always.mdc", "alwaysApply: true", "ALWAYS BODY")
		writeRule("onfile.mdc", 'globs: "src/api/**"', "GLOB BODY")

		// No trust decision for this cwd: a cloned repo's .agents/rules must
		// not reach the system prompt or steers before the folder is trusted.
		setProjectScopeTrusted(dir, false)

		const mock = createExtensionApi()
		agentsRulesExtension(mock.api)
		await mock.emit("session_start", { type: "session_start" }, makeCtx())

		const blocks = renderSystemPromptBlocks(SESSION_ID, { mode: "single" })
		expect(blocks.filter((b) => b.owner === "agents-rules")).toEqual([])

		await mock.emit(
			"tool_call",
			{ type: "tool_call", toolName: "edit", input: { path: join(dir, "src/api/x.ts") } },
			makeCtx(),
		)
		await mock.emit("tool_result", { type: "tool_result" }, makeCtx())
		expect(mock.sendMessage).not.toHaveBeenCalled()

		// Trust granted later re-fires discovery on the next session_start.
		setProjectScopeTrusted(dir, true)
		await mock.emit("session_start", { type: "session_start" }, makeCtx())
		expect(
			renderSystemPromptBlocks(SESSION_ID, { mode: "single" })
				.map((b) => b.content)
				.join("\n"),
		).toContain("ALWAYS BODY")
	})
})
