import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type EnvironmentInfo, buildSystemPrompt } from "./prompt-construction/system-prompt.js"
import tagsExtension, { TagManager, isValidTag, parseTag } from "./tags.js"

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

function makePi(): ExtensionAPI & {
	fire: (event: string, payload?: unknown, ctx?: unknown) => Promise<unknown[]>
	fireShutdown: () => void
	getActiveTools: () => string[]
	setActiveTools: (tools: string[]) => void
	tools: Map<string, RegisteredTool>
} {
	const shutdownHandlers: Array<() => void> = []
	const handlers = new Map<string, Handler[]>()
	const sessionStartCtx = { hasUI: false, sessionManager: { getSessionId: () => TEST_SESSION_ID } }
	const tools = new Map<string, RegisteredTool>()
	let activeTools: string[] = []
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool)
			activeTools.push(tool.name)
		},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next
		},
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
	}
	return pi as unknown as ExtensionAPI & {
		fire: (event: string, payload?: unknown, ctx?: unknown) => Promise<unknown[]>
		fireShutdown: () => void
		getActiveTools: () => string[]
		setActiveTools: (tools: string[]) => void
		tools: Map<string, RegisteredTool>
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
		pi.tools.get("set_phase")?.execute("call-1", { phase }, undefined, undefined, { hasUI: false })

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

			expect(result).toContain("## Phase Tagging for Analytics")
			expect(result).toContain("Call `set_phase` when the work type changes")
			expect(result).toContain("Subagents set their phase automatically from their persona")
			expect(result).not.toContain("questionnaire")
			expect(result.indexOf("## Phase Tagging for Analytics")).toBeLessThan(result.indexOf("## Available Tools"))
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
	})
})

describe("TagManager persistence", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-tags-test-"))
		configPath = join(tempDir, "tags.json")
		vi.stubEnv("KIMCHI_TAGS", "")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it("persists added tags to config file", () => {
		const manager = new TagManager(configPath)
		manager.add("project:test")

		const loaded = new TagManager(configPath)
		expect(loaded.getAllTags()).toContain("project:test")
	})

	it("loads tags from config file on initialization", () => {
		writeFileSync(configPath, JSON.stringify({ tags: ["env:prod", "team:backend"] }))

		const manager = new TagManager(configPath)
		expect(manager.getAllTags()).toEqual(expect.arrayContaining(["env:prod", "team:backend"]))
	})

	it("removes tags from config file when deleted", () => {
		writeFileSync(configPath, JSON.stringify({ tags: ["tag1:value1", "tag2:value2"] }))

		const manager = new TagManager(configPath)
		manager.remove("tag1:value1")

		const loaded = new TagManager(configPath)
		expect(loaded.getAllTags()).toEqual(["tag2:value2"])
	})

	it("clears all user tags from config file", () => {
		writeFileSync(configPath, JSON.stringify({ tags: ["tag1:value1", "tag2:value2", "tag3:value3"] }))

		const manager = new TagManager(configPath)
		manager.clear()

		const loaded = new TagManager(configPath)
		expect(loaded.getAllTags()).toEqual([])
	})

	it("creates config directory if it does not exist", () => {
		const nestedPath = join(tempDir, "nested", "config", "tags.json")

		const manager = new TagManager(nestedPath)
		manager.add("test:value")

		const loaded = new TagManager(nestedPath)
		expect(loaded.getAllTags()).toEqual(["test:value"])
	})
})

describe("TagManager.add", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-tags-test-"))
		configPath = join(tempDir, "tags.json")
		vi.stubEnv("KIMCHI_TAGS", "")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it("returns duplicate error before limit error when tag already exists at capacity", () => {
		const manager = new TagManager(configPath)
		for (let i = 0; i < 10; i++) {
			manager.add(`tag${i}:value`)
		}
		const result = manager.add("tag0:value")
		expect(result).toEqual({ success: false, error: `Tag "tag0:value" already exists.` })
	})

	it("returns limit error when adding a new tag at capacity", () => {
		const manager = new TagManager(configPath)
		for (let i = 0; i < 10; i++) {
			manager.add(`tag${i}:value`)
		}
		const result = manager.add("new:tag")
		expect(result).toEqual({ success: false, error: "Maximum 10 tags allowed (including static tags)." })
	})
})
