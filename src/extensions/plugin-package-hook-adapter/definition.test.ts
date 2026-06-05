import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	getResourceDefinition,
	getResourceDefinitions,
	invalidateResourceDefinitionsCache,
} from "../../resources/definitions.js"
import { discoverCommandHookResources } from "../hook-adapters/discovery.js"

// Isolate filesystem env
let dir: string
let oldAgentDir: string | undefined
let oldHome: string | undefined

beforeEach(() => {
	dir = join(tmpdir(), `kimchi-ppkg-def-${process.pid}-${Math.random().toString(16).slice(2)}`)
	mkdirSync(dir, { recursive: true })
	oldHome = process.env.HOME
	oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
	process.env.HOME = join(dir, "home")
	process.env.KIMCHI_CODING_AGENT_DIR = join(dir, "agent")
	invalidateResourceDefinitionsCache()
})

afterEach(() => {
	if (oldHome === undefined) {
		// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
		delete process.env.HOME
	} else {
		process.env.HOME = oldHome
	}
	if (oldAgentDir === undefined) {
		// biome-ignore lint/performance/noDelete: process.env requires delete to truly unset.
		delete process.env.KIMCHI_CODING_AGENT_DIR
	} else {
		process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
	}
	rmSync(dir, { recursive: true, force: true })
	invalidateResourceDefinitionsCache()
})

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}

function makeHooksFile(hooksDir: string): string {
	const hooksFile = join(hooksDir, "hooks.json")
	writeJson(hooksFile, {
		hooks: {
			SessionStart: [
				{
					hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/on-start" }],
				},
			],
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/pre-tool" }],
				},
			],
			PostToolUse: [
				{
					hooks: [{ type: "command", command: "post-tool" }],
				},
			],
		},
	})
	return hooksFile
}

describe("discoverCommandHookResources with pluginRoot", () => {
	it("expands ${CLAUDE_PLUGIN_ROOT} in SessionStart commands", () => {
		const pkgRoot = join(dir, "pkg-a")
		const hooksFile = makeHooksFile(join(pkgRoot, "hooks"))

		const definition = {
			id: "plugin-package",
			label: "Plugin package",
			customType: "kimchi-plugin-package-hook-context",
			supportedEvents: ["SessionStart"] as const,
			defaultTimeoutMs: 60_000,
			sessionStartDelivery: "systemPrompt" as const,
			sources: () => [{ scope: "user" as const, path: hooksFile, pluginRoot: pkgRoot }],
		}

		const resources = discoverCommandHookResources(definition)
		expect(resources).toHaveLength(1)
		expect(resources[0].command).toBe(`${pkgRoot}/bin/on-start`)
	})

	it("expands %CLAUDE_PLUGIN_ROOT% (Windows form) in commands", () => {
		const pkgRoot = join(dir, "pkg-win")
		const hooksFile = join(pkgRoot, "hooks", "hooks.json")
		writeJson(hooksFile, {
			hooks: {
				SessionStart: [
					{
						hooks: [{ type: "command", command: "%CLAUDE_PLUGIN_ROOT%\\bin\\on-start" }],
					},
				],
			},
		})

		const definition = {
			id: "plugin-package",
			label: "Plugin package",
			customType: "kimchi-plugin-package-hook-context",
			supportedEvents: ["SessionStart"] as const,
			defaultTimeoutMs: 60_000,
			sessionStartDelivery: "systemPrompt" as const,
			sources: () => [{ scope: "user" as const, path: hooksFile, pluginRoot: pkgRoot }],
		}

		const resources = discoverCommandHookResources(definition)
		expect(resources[0].command).toBe(`${pkgRoot}\\bin\\on-start`)
	})

	it("sets env.CLAUDE_PLUGIN_ROOT on the resource", () => {
		const pkgRoot = join(dir, "pkg-b")
		const hooksFile = makeHooksFile(join(pkgRoot, "hooks"))

		const definition = {
			id: "plugin-package",
			label: "Plugin package",
			customType: "kimchi-plugin-package-hook-context",
			supportedEvents: ["SessionStart"] as const,
			defaultTimeoutMs: 60_000,
			sessionStartDelivery: "systemPrompt" as const,
			sources: () => [{ scope: "user" as const, path: hooksFile, pluginRoot: pkgRoot }],
		}

		const resources = discoverCommandHookResources(definition)
		expect(resources[0].env).toEqual({ CLAUDE_PLUGIN_ROOT: pkgRoot })
	})

	it("only returns SessionStart hooks when supportedEvents=[SessionStart]", () => {
		const pkgRoot = join(dir, "pkg-c")
		const hooksFile = makeHooksFile(join(pkgRoot, "hooks"))

		const definition = {
			id: "plugin-package",
			label: "Plugin package",
			customType: "kimchi-plugin-package-hook-context",
			supportedEvents: ["SessionStart"] as const,
			defaultTimeoutMs: 60_000,
			sessionStartDelivery: "systemPrompt" as const,
			sources: () => [{ scope: "user" as const, path: hooksFile, pluginRoot: pkgRoot }],
		}

		const resources = discoverCommandHookResources(definition)
		expect(resources.every((r) => r.eventName === "SessionStart")).toBe(true)
		expect(resources).toHaveLength(1)
	})

	it("produces unique ids per source path (two packages with different roots)", () => {
		const pkgRootA = join(dir, "pkg-uniq-a")
		const pkgRootB = join(dir, "pkg-uniq-b")
		const hooksA = join(pkgRootA, "hooks", "hooks.json")
		const hooksB = join(pkgRootB, "hooks", "hooks.json")

		const singleHooks = {
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "start" }] }],
			},
		}
		writeJson(hooksA, singleHooks)
		writeJson(hooksB, singleHooks)

		const definition = {
			id: "plugin-package",
			label: "Plugin package",
			customType: "kimchi-plugin-package-hook-context",
			supportedEvents: ["SessionStart"] as const,
			defaultTimeoutMs: 60_000,
			sessionStartDelivery: "systemPrompt" as const,
			sources: () => [
				{ scope: "user" as const, path: hooksA, pluginRoot: pkgRootA },
				{ scope: "user" as const, path: hooksB, pluginRoot: pkgRootB },
			],
		}

		const resources = discoverCommandHookResources(definition)
		expect(resources).toHaveLength(2)
		const ids = resources.map((r) => r.id)
		expect(new Set(ids).size).toBe(2)
	})
})

describe("resource definition registry", () => {
	it("does not expose the plugin-package hook adapter as a user-visible resource", () => {
		// Always-on, hidden: no static definition, no per-hook definitions surface
		// in the resources/hooks menus.
		expect(getResourceDefinition("extensions.plugin-package-hook-adapter")).toBeUndefined()
		const defs = getResourceDefinitions()
		expect(defs.some((d) => d.id === "extensions.plugin-package-hook-adapter")).toBe(false)
		expect(defs.some((d) => d.id.startsWith("hooks.plugin-package."))).toBe(false)
	})

	it("getResourceDefinitions() does not throw or infinite-loop", () => {
		expect(() => getResourceDefinitions()).not.toThrow()
	})
})
