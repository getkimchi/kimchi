import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetOrgPolicyForTests } from "../org-policy.js"
import { setOrgPolicyForTests } from "../org-policy.test-utils.js"
import { getResourceOverride, isResourceEnabled } from "./store.js"
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
		resetOrgPolicyForTests()
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

	it("org-locked resources show an org-locked value and cannot be toggled", async () => {
		await setOrgPolicyForTests({ resources: { "tools.web_search": "FORCE_OFF" } })
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme
		const component = createResourceManager({ requestRender: vi.fn() } as unknown as TUI, theme, vi.fn(), "tools")

		const rendered = component.render(160).join("\n")
		// The value column names the org, not the raw API enum.
		expect(rendered).toContain("disabled (org-locked)")
		// The selected (locked) row explains why it cannot be toggled.
		expect(rendered).toContain("Managed by your organization: locked off (it cannot be enabled locally).")
		expect(rendered).toContain("org-locked")

		// Toggle attempt on the selected locked row: no values to cycle, so the
		// write never happens and the effective state stays forced off.
		component.handleInput(" ")
		expect(isResourceEnabled("tools.web_search")).toBe(false)
		expect(getResourceOverride("tools.web_search")).toBeUndefined()
	})

	it("aligns the value column across rows", async () => {
		await setOrgPolicyForTests({ resources: { "tools.web_search": "FORCE_OFF" } })
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme
		const component = createResourceManager({ requestRender: vi.fn() } as unknown as TUI, theme, vi.fn(), "tools")

		const lines = component.render(160).filter((line) => /Web (search|fetch)/.test(line))
		expect(lines).toHaveLength(2)
		// Every row's value starts at the same column, locked or not.
		const columns = lines.map((line) => {
			const enabled = line.indexOf("enabled")
			const disabled = line.indexOf("disabled")
			return enabled >= 0 ? enabled : disabled
		})
		expect(columns[0]).toBeGreaterThan(0)
		expect(new Set(columns).size).toBe(1)
	})
})

function selectedIndex(component: unknown): number {
	return ((component as { list: unknown }).list as { selectedIndex: number }).selectedIndex
}
