import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GOAL_RESOURCE_ID } from "../extensions/goal/constants.js"
import { enabledExtensionFactories } from "./filter.js"
import { setResourceOverride } from "./store.js"

let dir: string
let oldAgentDir: string | undefined

describe("enabledExtensionFactories", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-resource-filter-"))
		oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		process.env.KIMCHI_CODING_AGENT_DIR = dir
	})

	afterEach(() => {
		if (oldAgentDir === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
		else process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
		rmSync(dir, { recursive: true, force: true })
	})

	it("loads goal mode only after its experimental flag is enabled", () => {
		const factory = vi.fn() as unknown as ExtensionFactory
		const managed = [{ id: GOAL_RESOURCE_ID, factory }]

		expect(enabledExtensionFactories(managed)).toEqual([])
		setResourceOverride(GOAL_RESOURCE_ID, true)
		expect(enabledExtensionFactories(managed)).toEqual([factory])
	})
})
