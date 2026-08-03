import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { buildSystemPrompt, type EnvironmentInfo } from "./prompt-construction/system-prompt.js"

vi.mock("node:os", async (importOriginal) => {
	const { join } = await import("node:path")
	const mod = await importOriginal<typeof import("node:os")>()
	return {
		...mod,
		homedir: () => join(mod.tmpdir(), `kimchi-tags-mock-home-${process.pid}`),
	}
})

import tagsExtension, {
	getActiveTags,
	getCurrentPhase,
	isValidTag,
	parseTag,
	setCurrentPhase,
	TagManager,
} from "./tags.js"

const MOCK_HOME = join(tmpdir(), `kimchi-tags-mock-home-${process.pid}`)

type FakeSessionEntry = {
	type: "custom"
	customType: string
	data: unknown
	id: string
	parentId: null
	timestamp: string
}
const sessionEntriesStore = new Map<string, FakeSessionEntry[]>()

function clearSessionEntriesStore(): void {
	sessionEntriesStore.clear()
}

function appendEntryForSession(sessionId: string, customType: string, data: unknown): void {
	const entries = sessionEntriesStore.get(sessionId) ?? []
	entries.push({
		type: "custom",
		customType,
		data,
		id: `entry-${entries.length}`,
		parentId: null,
		timestamp: new Date().toISOString(),
	})
	sessionEntriesStore.set(sessionId, entries)
}

function getSessionEntries(sessionId: string): FakeSessionEntry[] {
	return sessionEntriesStore.get(sessionId) ?? []
}

function makeSessionManager(sessionId: string) {
	return {
		getSessionId: () => sessionId,
		getEntries: () => getSessionEntries(sessionId),
	}
}

function makeTagManager(sessionId = TEST_SESSION_ID) {
	const appendEntry = vi.fn((customType: string, data: unknown) => {
		appendEntryForSession(sessionId, customType, data)
	})
	const sessionManager = makeSessionManager(sessionId)
	return {
		manager: new TagManager(sessionManager, appendEntry),
		sessionManager,
		appendEntry,
	}
}

const testEnv: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
	osRelease: "6.1.0-test",
	osVersion: "#1 SMP PREEMPT_DYNAMIC Test",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/project",
	documentsDir: "/home/testuser/project/.kimchi/docs",
	localDate: "2026-01-01",
	isGitRepo: false,
}

type Handler = (event: unknown, ctx: unknown) => unknown
const TEST_SESSION_ID = "test-session"

type RegisteredTool = {
	name: string
	execute: (...args: unknown[]) => unknown
}

type RegisteredCommand = {
	name: string
	handler: (args: string, ctx: unknown) => unknown | Promise<unknown>
}

function makePi(): ExtensionAPI & {
	fire: (event: string, payload?: unknown, ctx?: unknown) => Promise<unknown[]>
	fireShutdown: () => void
	getActiveTools: () => string[]
	setActiveTools: (tools: string[]) => void
	appendEntry: (customType: string, data?: unknown) => void
	getEntries: (sessionId: string) => FakeSessionEntry[]
	tools: Map<string, RegisteredTool>
	commands: Map<string, RegisteredCommand>
	runCommand: (name: string, args: string, ctx?: unknown) => Promise<unknown>
} {
	const shutdownHandlers: Array<() => void> = []
	const handlers = new Map<string, Handler[]>()
	const sessionStartCtx = createContext({
		hasUI: false,
		sessionManager: makeSessionManager(TEST_SESSION_ID),
	})
	const tools = new Map<string, RegisteredTool>()
	const commands = new Map<string, RegisteredCommand>()
	let activeTools: string[] = []
	let activeSessionId = TEST_SESSION_ID
	const pi = {
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: unknown) => unknown | Promise<unknown> },
		) => {
			commands.set(name, { name, handler: command.handler })
		},
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool)
			activeTools.push(tool.name)
		},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next
		},
		setThinkingLevel: vi.fn(),
		appendEntry: (customType: string, data?: unknown) => {
			appendEntryForSession(activeSessionId, customType, data)
		},
		getEntries: (sessionId: string) => getSessionEntries(sessionId),
		on: (event: string, handler: Handler) => {
			const existing = handlers.get(event) ?? []
			existing.push(handler)
			handlers.set(event, existing)
			if (event === "session_shutdown") shutdownHandlers.push(handler as () => void)
			if (event === "session_start") handler({}, sessionStartCtx)
		},
		fire: async (event: string, payload: unknown = {}, ctx: unknown = {}) => {
			const results: unknown[] = []
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(payload, ctx))
			}
			return results
		},
		fireShutdown: () => {
			for (const handler of shutdownHandlers) handler()
		},
		tools,
		commands,
		runCommand: async (name: string, args: string, ctx = sessionStartCtx) => {
			const command = commands.get(name)
			if (!command) throw new Error(`Command "${name}" not registered`)
			activeSessionId = (ctx as { sessionManager: { getSessionId: () => string } }).sessionManager.getSessionId()
			return command.handler(args, ctx)
		},
	}
	return pi as unknown as ExtensionAPI & {
		fire: (event: string, payload?: unknown, ctx?: unknown) => Promise<unknown[]>
		fireShutdown: () => void
		getActiveTools: () => string[]
		setActiveTools: (tools: string[]) => void
		appendEntry: (customType: string, data?: unknown) => void
		getEntries: (sessionId: string) => FakeSessionEntry[]
		tools: Map<string, RegisteredTool>
		commands: Map<string, RegisteredCommand>
		runCommand: (name: string, args: string, ctx?: unknown) => Promise<unknown>
	}
}

describe("isValidTag", () => {
	const validCases = [
		"project:test",
		"team:backend",
		"milestone:M015",
		"key:value",
		"a:b",
		"project-1:test_v2",
		"app.name:version.1.0",
	]

	const invalidCases = [
		"invalid",
		":value",
		"key:",
		":",
		"",
		"key value",
		"key@value",
		`${"a".repeat(65)}:value`, // key too long
		`key:${"b".repeat(65)}`, // value too long
	]

	for (const tag of validCases) {
		it(`returns true for valid tag "${tag}"`, () => {
			expect(isValidTag(tag)).toBe(true)
		})
	}

	for (const tag of invalidCases) {
		it(`returns false for invalid tag "${tag}"`, () => {
			expect(isValidTag(tag)).toBe(false)
		})
	}
})

describe("parseTag", () => {
	const cases: Array<{
		tag: string
		expected: { key: string; value: string } | null
	}> = [
		{ tag: "project:test", expected: { key: "project", value: "test" } },
		{ tag: "team:backend", expected: { key: "team", value: "backend" } },
		{ tag: "milestone:M015", expected: { key: "milestone", value: "M015" } },
		{ tag: "invalid", expected: null },
		{ tag: "", expected: null },
	]

	for (const { tag, expected } of cases) {
		it(`parses "${tag}" correctly`, () => {
			expect(parseTag(tag)).toEqual(expected)
		})
	}
})

describe("tags system prompt block", () => {
	const makeTagsPi = () => {
		const pi = makePi()
		tagsExtension(pi)
		return pi
	}
	const setPhase = (pi: ReturnType<typeof makeTagsPi>, phase = "explore") =>
		pi.tools.get("set_phase")?.execute("call-1", { phase }, undefined, undefined, createContext({ hasUI: false }))

	it("registers phase tagging instructions with the extension that owns set_phase", async () => {
		const pi = makeTagsPi()

		try {
			const result = buildSystemPrompt({
				tools: [
					{ name: "read", description: "Read file contents" },
					{ name: "set_phase", description: "Set the current work phase" },
				],
				env: testEnv,
				mode: "orchestrator",
				sessionId: TEST_SESSION_ID,
			})

			expect(result).toContain("## Phase Management")
			expect(result).toContain("Call `set_phase` when the work type changes")
			expect(result).toContain("Subagents set their phase automatically from their persona")
			expect(result).not.toContain("questionnaire")
			expect(result.indexOf("## Phase Management")).toBeLessThan(result.indexOf("## Available Tools"))
		} finally {
			pi.fireShutdown()
		}
	})

	it("set_phase changes the current phase", async () => {
		const pi = makeTagsPi()

		const result = await setPhase(pi)

		expect(result).toMatchObject({
			content: [{ type: "text", text: "Phase changed to: explore" }],
			details: { phase: "explore" },
		})
		expect(pi.setThinkingLevel).not.toHaveBeenCalled()
	})

	it("set_phase updates thinking level when performing a phase itself", async () => {
		const pi = makeTagsPi()

		const result = await pi.tools
			.get("set_phase")
			?.execute("call-1", { phase: "plan", thinking: "high" }, undefined, undefined, createContext({ hasUI: false }))

		expect(result).toMatchObject({
			content: [{ type: "text", text: "Phase changed to: plan" }],
			details: { phase: "plan", thinking: "high" },
		})
		expect(pi.setThinkingLevel).toHaveBeenCalledWith("high")
	})
})

describe("TagManager persistence", () => {
	beforeEach(() => {
		rmSync(MOCK_HOME, { recursive: true, force: true })
		mkdirSync(MOCK_HOME, { recursive: true })
		vi.stubEnv("KIMCHI_TAGS", "")
		clearSessionEntriesStore()
	})

	afterEach(() => {
		rmSync(MOCK_HOME, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it("persists added tags to session entries", () => {
		const { manager, appendEntry } = makeTagManager()
		manager.add("project:test")

		expect(appendEntry).toHaveBeenCalledWith("kimchi_active_tags", ["project:test"])

		const { manager: loaded } = makeTagManager()
		expect(loaded.getAllTags()).toContain("project:test")
	})

	it("loads tags from session entries on initialization", () => {
		appendEntryForSession(TEST_SESSION_ID, "kimchi_active_tags", ["env:prod", "team:backend"])

		const { manager } = makeTagManager()
		expect(manager.getAllTags()).toEqual(expect.arrayContaining(["env:prod", "team:backend"]))
	})

	it("falls back to config file for new sessions", () => {
		const configPath = join(MOCK_HOME, ".config", "kimchi", "tags.json")
		mkdirSync(dirname(configPath), { recursive: true })
		writeFileSync(configPath, JSON.stringify({ tags: ["env:prod", "team:backend"] }))

		const { manager } = makeTagManager()
		expect(manager.getAllTags()).toEqual(expect.arrayContaining(["env:prod", "team:backend"]))
	})

	it("falls back to env tags for new sessions", () => {
		vi.stubEnv("KIMCHI_TAGS", "env:prod,team:backend")

		const { manager } = makeTagManager()
		expect(manager.getAllTags()).toEqual(expect.arrayContaining(["env:prod", "team:backend"]))
	})

	it("session tags take priority over config/env for existing sessions", () => {
		appendEntryForSession(TEST_SESSION_ID, "kimchi_active_tags", ["team:frontend"])
		vi.stubEnv("KIMCHI_TAGS", "env:prod,team:backend")

		const { manager } = makeTagManager()
		expect(manager.getAllTags()).toEqual(["team:frontend"])
	})

	it("removes tags from session entries when deleted", () => {
		appendEntryForSession(TEST_SESSION_ID, "kimchi_active_tags", ["tag1:value1", "tag2:value2"])

		const { manager } = makeTagManager()
		manager.remove("tag1:value1")

		const { manager: loaded } = makeTagManager()
		expect(loaded.getAllTags()).toEqual(["tag2:value2"])
	})

	it("clears all tags from session entries", () => {
		appendEntryForSession(TEST_SESSION_ID, "kimchi_active_tags", ["tag1:value1", "tag2:value2", "tag3:value3"])

		const { manager } = makeTagManager()
		manager.clear()

		const { manager: loaded } = makeTagManager()
		expect(loaded.getAllTags()).toEqual([])
	})
})

describe("TagManager.add", () => {
	beforeEach(() => {
		rmSync(MOCK_HOME, { recursive: true, force: true })
		mkdirSync(MOCK_HOME, { recursive: true })
		vi.stubEnv("KIMCHI_TAGS", "")
		clearSessionEntriesStore()
	})

	afterEach(() => {
		rmSync(MOCK_HOME, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it("returns duplicate error before limit error when tag already exists at capacity", () => {
		const { manager } = makeTagManager()
		for (let i = 0; i < 10; i++) {
			manager.add(`tag${i}:value`)
		}
		const result = manager.add("tag0:value")
		expect(result).toEqual({ success: false, error: `Tag "tag0:value" already exists.` })
	})

	it("returns limit error when adding a new tag at capacity", () => {
		const { manager } = makeTagManager()
		for (let i = 0; i < 10; i++) {
			manager.add(`tag${i}:value`)
		}
		const result = manager.add("new:tag")
		expect(result).toEqual({ success: false, error: "Maximum 10 tags allowed (including default tags)." })
	})
})

function commandContext(sessionId: string) {
	return createContext({
		hasUI: false,
		sessionManager: makeSessionManager(sessionId),
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as unknown as ExtensionUIContext["theme"],
		},
	})
}

describe("getCurrentPhase", () => {
	beforeEach(() => {
		rmSync(MOCK_HOME, { recursive: true, force: true })
		mkdirSync(MOCK_HOME, { recursive: true })
		vi.stubEnv("KIMCHI_TAGS", "")
	})

	afterEach(() => {
		rmSync(MOCK_HOME, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it("returns undefined before a phase is set", () => {
		expect(getCurrentPhase("fresh-session")).toBeUndefined()
	})

	it("returns the phase set for a specific session", () => {
		setCurrentPhase("get-phase-session", "plan")
		expect(getCurrentPhase("get-phase-session")).toBe("plan")
	})

	it("isolates phases between sessions", () => {
		setCurrentPhase("get-phase-a", "plan")
		setCurrentPhase("get-phase-b", "build")
		expect(getCurrentPhase("get-phase-a")).toBe("plan")
		expect(getCurrentPhase("get-phase-b")).toBe("build")
	})
})

describe("setCurrentPhase", () => {
	beforeEach(() => {
		rmSync(MOCK_HOME, { recursive: true, force: true })
		mkdirSync(MOCK_HOME, { recursive: true })
		vi.stubEnv("KIMCHI_TAGS", "")
	})

	afterEach(() => {
		rmSync(MOCK_HOME, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it("sets a valid phase", () => {
		setCurrentPhase("set-phase-session", "review")
		expect(getCurrentPhase("set-phase-session")).toBe("review")
	})

	it("ignores invalid phases", () => {
		setCurrentPhase("invalid-phase-session", "invalid")
		expect(getCurrentPhase("invalid-phase-session")).toBeUndefined()
	})

	it("clears the phase when given undefined", () => {
		setCurrentPhase("clear-phase-session", "build")
		expect(getCurrentPhase("clear-phase-session")).toBe("build")
		setCurrentPhase("clear-phase-session", undefined)
		expect(getCurrentPhase("clear-phase-session")).toBeUndefined()
	})
})

describe("getActiveTags", () => {
	beforeEach(() => {
		rmSync(MOCK_HOME, { recursive: true, force: true })
		mkdirSync(MOCK_HOME, { recursive: true })
		vi.stubEnv("KIMCHI_TAGS", "")
		clearSessionEntriesStore()
	})

	afterEach(() => {
		rmSync(MOCK_HOME, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it("returns an empty array before tags are added", () => {
		expect(getActiveTags(makeSessionManager("fresh-tags-session"))).toEqual([])
	})

	it("returns tags added through the extension command", async () => {
		const pi = makePi()
		tagsExtension(pi)
		await pi.runCommand("tags", "add team:backend", commandContext("command-tags-session"))
		expect(getActiveTags(makeSessionManager("command-tags-session"))).toEqual(["team:backend"])
	})

	it("isolates tags between sessions", async () => {
		const pi = makePi()
		tagsExtension(pi)
		await pi.runCommand("tags", "add team:backend", commandContext("tags-session-a"))
		expect(getActiveTags(makeSessionManager("tags-session-a"))).toEqual(["team:backend"])
		expect(getActiveTags(makeSessionManager("tags-session-b"))).toEqual([])
	})
})
