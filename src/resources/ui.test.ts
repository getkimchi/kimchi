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
			delete process.env.KIMCHI_CODING_AGENT_DIR
		} else {
			process.env.KIMCHI_CODING_AGENT_DIR = oldAgentDir
		}
		if (oldHome === undefined) {
			delete process.env.HOME
		} else {
			process.env.HOME = oldHome
		}
		rmSync(dir, { recursive: true, force: true })
	})

	it("keeps the selected row after toggling a resource", () => {
		const component = createResourceManager({ requestRender: vi.fn() } as unknown as TUI, {} as Theme, vi.fn(), "hooks")

		expect(selectedIndex(component)).toBe(0)
		expect(isResourceEnabled("hooks.bash")).toBe(true)

		component.handleInput(" ")

		expect(isResourceEnabled("hooks.bash")).toBe(false)
		expect(selectedIndex(component)).toBe(0)
	})

	it("shows experimental resources in their own tab without changing their persisted id", () => {
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme
		const component = createResourceManager({ requestRender: vi.fn() } as unknown as TUI, theme, vi.fn(), "plugins")

		component.handleInput("\t")
		const experimentalTab = component.render(160).join("\n")

		expect(experimentalTab).toContain("Experimental")
		expect(experimentalTab).toContain("extensions.ferment-v2")
		expect(isResourceEnabled("extensions.ferment-v2")).toBe(false)

		component.handleInput(" ")

		expect(isResourceEnabled("extensions.ferment-v2")).toBe(true)
		const extensions = createResourceManager({ requestRender: vi.fn() } as unknown as TUI, theme, vi.fn(), "extensions")
		expect(extensions.render(160).join("\n")).not.toContain("extensions.ferment-v2")
	})
})

function selectedIndex(component: unknown): number {
	return ((component as { list: unknown }).list as { selectedIndex: number }).selectedIndex
}
