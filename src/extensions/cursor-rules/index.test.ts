import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderSystemPromptBlocks } from "../prompt-construction/system-prompt-blocks.js"
import cursorRulesExtension from "./index.js"
import type { ParsedCursorRule } from "./types.js"

const tmpBase = join(tmpdir(), `kimchi-cursor-rules-ext-${Date.now()}`)
let sessionCounter = 0

vi.mock("./discovery.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./discovery.js")>()
	return {
		...actual,
		discoverCursorRules: vi.fn(),
	}
})

const { discoverCursorRules } = await import("./discovery.js")

type EventHandler = (...args: unknown[]) => Promise<unknown>
type ShutdownHandler = () => void

interface TestPi {
	api: ExtensionAPI
	renderBlock: () => string | undefined
	handlers: Record<string, EventHandler[]>
	fireShutdown: () => void
}

const activePis: TestPi[] = []

function makePi(rules: ParsedCursorRule[]): TestPi {
	const handlers: Record<string, EventHandler[]> = {}
	const shutdownHandlers: ShutdownHandler[] = []
	sessionCounter += 1
	const sessionId = `cursor-rules-test-${sessionCounter}`
	const ctx: ExtensionContext = {
		cwd: tmpBase,
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext

	const api: ExtensionAPI = {
		on(event: string, handler: EventHandler) {
			handlers[event] = handlers[event] ?? []
			handlers[event].push(handler)
			if (event === "session_shutdown") {
				shutdownHandlers.push(handler as ShutdownHandler)
			}
		},
	} as unknown as ExtensionAPI

	vi.mocked(discoverCursorRules).mockReturnValue({ rules })
	cursorRulesExtension(api)

	// Fire session_start once after all handlers are registered, mirroring how
	// pi-mono fires the event once the session is created.
	for (const handler of handlers.session_start ?? []) {
		void handler({}, ctx)
	}

	const pi: TestPi = {
		api,
		handlers,
		fireShutdown: () => {
			for (const handler of shutdownHandlers) handler()
		},
		renderBlock: () => {
			const blocks = renderSystemPromptBlocks(sessionId, { mode: "orchestrator" })
			if (blocks.length === 0) return undefined
			return blocks.map((b) => b.content).join("\n\n")
		},
	}
	activePis.push(pi)
	return pi
}

describe("cursorRulesExtension", () => {
	beforeEach(() => {
		rmSync(tmpBase, { recursive: true, force: true })
		mkdirSync(tmpBase, { recursive: true })
	})

	afterEach(() => {
		rmSync(tmpBase, { recursive: true, force: true })
		for (const pi of activePis.splice(0)) pi.fireShutdown()
		vi.restoreAllMocks()
	})

	it("renders nothing when no rules exist", () => {
		const { renderBlock } = makePi([])
		expect(renderBlock()).toBeUndefined()
	})

	it("injects alwaysApply rules on session start", () => {
		const rule: ParsedCursorRule = {
			path: "/project/.cursor/rules/always.mdc",
			description: "Always",
			globs: [],
			alwaysApply: true,
			body: "Always apply this.",
		}
		const { renderBlock } = makePi([rule])
		const rendered = renderBlock()
		expect(rendered).toContain("Always apply this.")
		expect(rendered).toContain("/project/.cursor/rules/always.mdc")
	})

	it("injects glob-matched rules after a matching tool_call", async () => {
		const rule: ParsedCursorRule = {
			path: join(tmpBase, ".cursor/rules/ts.mdc"),
			description: "TS",
			globs: ["src/**/*.ts"],
			alwaysApply: false,
			body: "TypeScript rule.",
		}
		const { handlers, renderBlock } = makePi([rule])

		const toolHandlers = handlers.tool_call ?? []
		expect(toolHandlers.length).toBe(1)
		await toolHandlers[0]({ toolName: "read", input: { path: "src/foo.ts" } })

		const rendered = renderBlock()
		expect(rendered).toContain("TypeScript rule.")
		expect(rendered).toContain("src/**/*.ts")
	})

	it("does not inject glob rules before a matching file is touched", () => {
		const rule: ParsedCursorRule = {
			path: "/project/.cursor/rules/ts.mdc",
			description: "TS",
			globs: ["src/**/*.ts"],
			alwaysApply: false,
			body: "TypeScript rule.",
		}
		const { renderBlock } = makePi([rule])
		const rendered = renderBlock()
		expect(rendered).toBeUndefined()
	})

	it("lists available rules when no alwaysApply or glob rule matches", () => {
		const rule: ParsedCursorRule = {
			path: "/project/.cursor/rules/described.mdc",
			description: "API conventions",
			globs: [],
			alwaysApply: false,
			body: "Described rule.",
		}
		const { renderBlock } = makePi([rule])
		const rendered = renderBlock()
		expect(rendered).toContain("available for this project")
		expect(rendered).toContain("described.mdc")
		expect(rendered).toContain("API conventions")
	})

	it("ignores non-file tools when tracking touched files", async () => {
		const rule: ParsedCursorRule = {
			path: "/project/.cursor/rules/ts.mdc",
			description: "TS",
			globs: ["src/**/*.ts"],
			alwaysApply: false,
			body: "TypeScript rule.",
		}
		const { handlers, renderBlock } = makePi([rule])
		const toolHandlers = handlers.tool_call ?? []
		await toolHandlers[0]({ toolName: "bash", input: { command: "cat src/foo.ts" } })
		expect(renderBlock()).toBeUndefined()
	})
})
