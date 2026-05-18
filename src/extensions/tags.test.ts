import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type EnvironmentInfo, buildSystemPrompt } from "./prompt-construction/system-prompt.js"
import tagsExtension, { TagManager, isValidTag, parseTag } from "./tags.js"

const testEnv: EnvironmentInfo = {
	os: "Linux",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/project",
	documentsDir: "/home/testuser/project/.kimchi/docs",
	currentTime: "2026-01-01T00:00:00.000Z",
	localDate: "2026-01-01",
	isGitRepo: false,
}

type Handler = (event: unknown, ctx: unknown) => unknown

function makePi(): ExtensionAPI & { fireShutdown: () => void } {
	const shutdownHandlers: Array<() => void> = []
	const pi = {
		registerCommand: () => {},
		registerTool: () => {},
		on: (event: string, handler: Handler) => {
			if (event === "session_shutdown") shutdownHandlers.push(handler as () => void)
		},
		fireShutdown: () => {
			for (const handler of shutdownHandlers) handler()
		},
	}
	return pi as unknown as ExtensionAPI & { fireShutdown: () => void }
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
	it("registers phase tagging instructions with the extension that owns set_phase", () => {
		const pi = makePi()
		tagsExtension(pi)

		try {
			const result = buildSystemPrompt({
				pi,
				tools: [
					{ name: "read", description: "Read file contents" },
					{ name: "set_phase", description: "Set the current work phase" },
				],
				env: testEnv,
				mode: "orchestrator",
			})

			expect(result).toContain("## Phase Tagging for Analytics")
			expect(result).toContain("You must call `set_phase` before every block of work")
			expect(result.indexOf("## Phase Tagging for Analytics")).toBeLessThan(result.indexOf("## Available Tools"))
		} finally {
			pi.fireShutdown()
		}
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
