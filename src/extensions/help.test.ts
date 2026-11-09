import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent"
import { type Component, visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { createCommandContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import helpExtension from "./help.js"
import { SLASH_COMMANDS } from "./slash-commands.js"

const keyboardCapabilityMock = vi.hoisted(() => ({ kittySupport: undefined as boolean | undefined }))
vi.mock("./terminal-compat/keyboard-capability.js", () => ({
	getKittyKeyboardSupport: () => keyboardCapabilityMock.kittySupport,
}))

type OverlayFactory = (
	tui: { requestRender: () => void; terminal: { rows: number; cols: number } },
	theme: Theme,
	kb: unknown,
	done: () => void,
) => Component

// Identity theme: the assertions below match on plain text (`Ctrl+1\s+Rate…`),
// which ANSI colour codes from the shared testTheme would split.
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

/** Register the extension against the shared ExtensionAPI mock and return the /help handler. */
function registerHelp(): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
	const harness = createExtensionApi()
	helpExtension(harness.api)
	const handler = harness.getRegisteredCommand("help").handler
	expect(handler).toBeDefined()
	return handler as (args: string, ctx: ExtensionCommandContext) => Promise<void>
}

async function mountHelpOverlay(): Promise<Component> {
	const handler = registerHelp()
	let component: Component | undefined
	const ctx = createCommandContext()
	vi.mocked(ctx.ui.custom).mockImplementation(async (factory) => {
		component = (factory as unknown as OverlayFactory)(
			{ requestRender: vi.fn(), terminal: { rows: 40, cols: 80 } },
			plainTheme(),
			{},
			() => {},
		)
		return undefined
	})
	await handler("", ctx)
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
	// Registered commands deliberately kept out of /help. Adding a command to
	// src/ without listing it here or in SLASH_COMMANDS fails the inverse guard,
	// so the curation decision is always explicit.
	const INTERNAL_COMMANDS = new Set([
		// debugging / developer switches
		"cc-spinner",
		"cc-theme",
		"cc-tools",
		"thinking-steps",
		"strip-images",
		"memory-residency",
		"session-costs",
		"budget",
		"clear",
		// advanced or undocumented surfaces
		"plugins",
		"ssh-config",
		"remote-run",
		"ferment-v2",
		// feature-gated: the command only exists when extensions.memory is enabled
		"memory",
		// deprecated since the Auto default (#1357); kept for role configuration
		"multi-model",
		// matched by the constant scan but not slash commands
		"mcp-keyring-helper",
		"plannotator-review",
	])

	/** Every command name registered anywhere in src/ (non-test `.ts` files).
	 *  Supported registration forms — anything else is invisible to the scan
	 *  and fails the guard below with "no extension registers it":
	 *    - `registerCommand("name"` with a double-quoted literal (biome enforces
	 *      double quotes repo-wide, so single quotes never occur);
	 *    - a `const *_COMMAND* = "name"` constant passed to registerCommand
	 *      (todos, ferment-v2). This also picks up two constants that are not
	 *      slash commands (mcp-keyring-helper, plannotator-review); they are
	 *      listed in INTERNAL_COMMANDS so the inverse guard ignores them. */
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

	it("lists, or explicitly excludes, every command kimchi registers", () => {
		// The inverse guard: this PR back-filled 14 user-facing commands that had
		// shipped without a /help entry. A new command must now be listed or
		// named in INTERNAL_COMMANDS — silent omission is no longer possible.
		const unaccounted = [...registeredCommandNames()].filter(
			(name) => !(name in SLASH_COMMANDS) && !INTERNAL_COMMANDS.has(name) && !DEPENDENCY_COMMANDS.has(name),
		)
		expect(unaccounted, "registered but neither in /help nor in INTERNAL_COMMANDS").toEqual([])
		// And the exclusion list must not go stale either.
		const registered = registeredCommandNames()
		for (const name of INTERNAL_COMMANDS) {
			expect(registered.has(name), `INTERNAL_COMMANDS names /${name}, which nothing registers any more`).toBe(true)
			expect(SLASH_COMMANDS, `/${name} is both excluded and listed`).not.toHaveProperty(name)
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
		const handler = registerHelp()
		const ctx: ExtensionCommandContext = { ...createCommandContext(), mode: "rpc" }
		await handler("", ctx)
		const text = String(vi.mocked(ctx.ui.notify).mock.calls[0]?.[0])
		for (const name of ["work", "theme", "processes", "branch", "btw", "update", "teleport", "status", "hooks"]) {
			expect(text).toContain(`/${name}`)
		}
		expect(text).not.toContain("/multi-model")
	})
})
