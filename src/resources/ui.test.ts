import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isResourceEnabled } from "./store.js"
import { createResourceManager } from "./ui.js"

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()
	return {
		...actual,
		getSettingsListTheme: () => ({
			label: (text: string) => text,
			value: (text: string) => text,
			description: (text: string) => text,
			cursor: "→ ",
			hint: (text: string) => text,
		}),
	}
})

let dir: string
let oldAgentDir: string | undefined
let oldHome: string | undefined
let oldCwd: string

describe("ResourceManagerComponent", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-resources-ui-"))
		mkdirSync(join(dir, "project"), { recursive: true })
		oldAgentDir = process.env.KIMCHI_CODING_AGENT_DIR
		oldHome = process.env.HOME
		oldCwd = process.cwd()
		process.env.KIMCHI_CODING_AGENT_DIR = join(dir, "agent")
		process.env.HOME = join(dir, "home")
		process.chdir(join(dir, "project"))
	})

	afterEach(() => {
		process.chdir(oldCwd)
		if (oldAgentDir === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete operator to be truly unset.
			delete process.env.KIMCHI_CODING_AGENT_DIR
		} else {
			process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
		}
		if (oldHome === undefined) {
			// biome-ignore lint/performance/noDelete: process.env requires delete operator to be truly unset.
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("keeps the selected row after toggling a resource", () => {
		const component = createResourceManager({ requestRender: vi.fn() } as unknown as TUI, {} as Theme, vi.fn(), "hooks")

		component.handleInput("\x1b[B")
		expect(selectedIndex(component)).toBe(1)
		expect(isResourceEnabled("hooks.rtk-rewrite")).toBe(true)

		component.handleInput(" ")

		expect(isResourceEnabled("hooks.rtk-rewrite")).toBe(false)
		expect(selectedIndex(component)).toBe(1)
	})
})

function selectedIndex(component: unknown): number {
	return ((component as { list: unknown }).list as { selectedIndex: number }).selectedIndex
}
