import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { type Component, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import helpExtension from "./help.js"
import { SLASH_COMMANDS } from "./slash-commands.js"

const keyboardCapabilityMock = vi.hoisted(() => ({ kittySupport: undefined as boolean | undefined }))
vi.mock("./terminal-compat/keyboard-capability.js", () => ({
	getKittyKeyboardSupport: () => keyboardCapabilityMock.kittySupport,
}))

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>
type OverlayFactory = (
	tui: { requestRender: () => void; terminal: { rows: number; cols: number } },
	theme: Theme,
	kb: unknown,
	done: () => void,
) => Component

function plainTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme
}

async function mountHelpOverlay(): Promise<Component> {
	let handler: CommandHandler | undefined
	const pi = {
		registerCommand: (_name: string, def: { handler: CommandHandler }) => {
			handler = def.handler
		},
	} as unknown as ExtensionAPI
	helpExtension(pi)
	expect(handler).toBeDefined()

	let component: Component | undefined
	const ctx = {
		mode: "tui",
		ui: {
			custom: vi.fn(async (factory: OverlayFactory) => {
				component = factory({ requestRender: vi.fn(), terminal: { rows: 40, cols: 80 } }, plainTheme(), {}, () => {})
				return undefined
			}),
		},
	} as unknown as ExtensionContext
	await handler?.("", ctx)
	expect(component).toBeDefined()
	return component as Component
}

describe("help overlay — narrow terminals", () => {
	// Regression: border title math produced a negative "─".repeat count below
	// the title width, crashing with RangeError.
	for (const width of [1, 2, 3, 4, 5, 8, 10, 16, 24]) {
		it(`renders without crashing or overflowing at width ${width}`, async () => {
			const component = await mountHelpOverlay()
			let lines: string[] = []
			expect(() => {
				lines = component.render(width)
			}).not.toThrow()
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width)
			}
		})
	}
})

describe("help — rating shortcuts", () => {
	async function renderHelp(): Promise<string> {
		const component = await mountHelpOverlay()
		return component.render(80).join("\n")
	}

	it("lists Ctrl+1/Ctrl+2 when the terminal supports the Kitty keyboard protocol", async () => {
		keyboardCapabilityMock.kittySupport = true
		onTestFinished(() => {
			keyboardCapabilityMock.kittySupport = undefined
		})
		const text = await renderHelp()
		expect(text).toMatch(/Ctrl\+1\s+Rate response as Good/)
		expect(text).toMatch(/Ctrl\+2\s+Rate response as Bad/)
	})

	it("lists the Ctrl+R rating picker when the terminal lacks the Kitty keyboard protocol", async () => {
		keyboardCapabilityMock.kittySupport = false
		onTestFinished(() => {
			keyboardCapabilityMock.kittySupport = undefined
		})
		const text = await renderHelp()
		expect(text).toMatch(/Ctrl\+R\s+Rate response \(Good\/Bad picker\)/)
		expect(text).not.toContain("Ctrl+1")
		expect(text).not.toContain("Ctrl+2")
	})
})

describe("help — slash command list", () => {
	// pi's interactive mode handles these itself (/settings, /model and
	// /scoped-models in its submit handler; /compact, /name and /new as core
	// commands), so no kimchi extension ever calls registerCommand for them.
	const PI_BUILTIN_COMMANDS = new Set(["settings", "model", "scoped-models", "compact", "name", "new"])
	// Registered by a dependency, not by kimchi source: pi-mcp-adapter registers
	// /mcp through the proxy in src/extensions/mcp/index.ts (which drops the
	// adapter's pi-mcp / mcp-adapter aliases).
	const DEPENDENCY_COMMANDS = new Set(["mcp"])

	/** Every command name registered anywhere in src/ (non-test files): the
	 *  literal `registerCommand("name"` form plus the `*_COMMAND = "name"`
	 *  constants a few extensions pass instead (todos, ferment-v2). */
	function registeredCommandNames(): Set<string> {
		const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
		const names = new Set<string>()
		const visit = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name)
				if (entry.isDirectory()) {
					if (entry.name !== "node_modules") visit(path)
					continue
				}
				if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue
				const source = readFileSync(path, "utf8")
				for (const match of source.matchAll(/registerCommand\(\s*"([a-z][a-z0-9-]*)"/g)) names.add(match[1])
				for (const match of source.matchAll(/const [A-Z0-9_]*COMMAND[A-Z0-9_]* = "([a-z][a-z0-9-]*)"/g)) {
					names.add(match[1])
				}
			}
		}
		visit(srcRoot)
		return names
	}

	it("only lists commands that a kimchi extension registers or pi provides", () => {
		// A /help entry for a command nothing registers sends users to "unknown
		// command" — this is how stale entries (and typos) are caught.
		const registered = registeredCommandNames()
		for (const name of Object.keys(SLASH_COMMANDS)) {
			if (PI_BUILTIN_COMMANDS.has(name) || DEPENDENCY_COMMANDS.has(name)) continue
			expect(registered.has(name), `/${name} is listed in /help but no extension registers it`).toBe(true)
		}
	})

	it("no longer lists the deprecated /multi-model and describes /resources as the resources manager", () => {
		// Multi-model is deprecated since the Auto default (#1357); the command
		// still exists for role configuration but is not advertised.
		expect(SLASH_COMMANDS).not.toHaveProperty("multi-model")
		expect(SLASH_COMMANDS.resources.hint).toMatch(/hooks, tools, extensions/)
		expect(SLASH_COMMANDS.resources.hint).not.toMatch(/files, URLs, images/)
	})

	it("prints the user-facing commands that were missing from the list", async () => {
		// The non-TUI branch prints every row at once (the overlay scrolls, so a
		// 40-row render would only show the top of the list).
		let handler: CommandHandler | undefined
		const pi = {
			registerCommand: (_name: string, def: { handler: CommandHandler }) => {
				handler = def.handler
			},
		} as unknown as ExtensionAPI
		helpExtension(pi)
		const notify = vi.fn()
		await handler?.("", { mode: "rpc", ui: { notify } } as unknown as ExtensionContext)
		const text = String(notify.mock.calls[0]?.[0])
		for (const name of ["work", "theme", "processes", "branch", "update", "teleport", "status", "hooks"]) {
			expect(text).toContain(`/${name}`)
		}
		expect(text).not.toContain("/multi-model")
	})
})
