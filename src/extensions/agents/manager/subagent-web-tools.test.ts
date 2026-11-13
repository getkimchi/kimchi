/**
 * Subagent web factories: global-cleanup ownership tests.
 *
 * web-fetch's cache and Playwright browser pool are module singletons shared
 * by every session in the process. The extension's session_shutdown handler
 * tears both down — correct for the parent session, catastrophic for a child:
 * a subagent ending would wipe the shared cache and kill the shared browser
 * while the parent (or a sibling subagent) could be mid-fetch. The runner's
 * factories therefore bind no shutdown teardown while the parent manifest
 * keeps it.
 *
 * These tests stub the ExtensionAPI surface the web factories touch and
 * capture handler registration + tool registration directly.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cacheClear, cacheGet, cacheSet } from "../../web-fetch/cache.js"
import { WEB_TOOL_MANAGED_FACTORIES, subagentWebToolFactories } from "./subagent-web-tools.js"

const AGENT_DIR_SETTINGS = { resources: { "tools.web_search": true, "tools.web_fetch": true } }

function makeCapturingPi() {
	const tools: string[] = []
	const handlers = new Map<string, Array<() => unknown>>()
	const pi = {
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		on: (event: string, handler: () => unknown) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		},
	} as unknown as ExtensionAPI
	return { pi, tools, handlers }
}

describe("subagent web tool factories — global cleanup ownership", () => {
	let savedAgentDir: string | undefined
	let agentDir: string

	beforeEach(() => {
		savedAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		agentDir = mkdtempSync(join(tmpdir(), "kimchi-subagent-web-tools-"))
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(AGENT_DIR_SETTINGS))
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
	})

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
		else process.env.KIMCHI_CODING_AGENT_DIR = savedAgentDir
		rmSync(agentDir, { recursive: true, force: true })
		cacheClear()
	})

	it("child factories register the tools but bind NO session_shutdown teardown", () => {
		const factories = subagentWebToolFactories()
		expect(factories).toHaveLength(2)

		const { pi, tools, handlers } = makeCapturingPi()
		for (const factory of factories) void factory(pi)

		expect(tools).toEqual(["web_fetch", "web_search"])
		expect(handlers.has("session_shutdown")).toBe(false)
	})

	it("a child session ending leaves the shared cache intact", () => {
		const factories = subagentWebToolFactories()
		const { pi, handlers } = makeCapturingPi()
		for (const factory of factories) void factory(pi)

		cacheSet("https://example.com", "markdown", "shared content")
		cacheSet("https://example.org", "markdown", "other shared content")
		for (const handler of handlers.get("session_shutdown") ?? []) void handler()

		expect(cacheGet("https://example.com", "markdown")).toBe("shared content")
		expect(cacheGet("https://example.org", "markdown")).toBe("other shared content")
	})

	it("the parent manifest factories still bind shutdown cleanup", () => {
		const fetchEntry = WEB_TOOL_MANAGED_FACTORIES.find((entry) => entry.id === "tools.web_fetch")
		expect(fetchEntry).toBeDefined()

		const { pi, handlers } = makeCapturingPi()
		void fetchEntry?.factory(pi)

		cacheSet("https://example.com", "markdown", "shared content")
		const shutdownHandlers = handlers.get("session_shutdown") ?? []
		expect(shutdownHandlers).toHaveLength(1)
		for (const handler of shutdownHandlers) void handler()
		expect(cacheGet("https://example.com", "markdown")).toBeUndefined()
	})

	it("gating still applies per resource toggle on the child path", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ resources: { "tools.web_search": true, "tools.web_fetch": false } }),
		)

		const factories = subagentWebToolFactories()
		expect(factories).toHaveLength(1)

		const { pi, tools } = makeCapturingPi()
		for (const factory of factories) void factory(pi)
		expect(tools).toEqual(["web_search"])
	})
})
