import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runPlugin } from "./plugin.js"

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

describe("runPlugin", () => {
	let logSpy: ReturnType<typeof vi.spyOn>
	let errSpy: ReturnType<typeof vi.spyOn>
	let claudeHome: string
	let configTmpDir: string
	let configPath: string

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		claudeHome = mkdtempSync(join(tmpdir(), "kimchi-claude-home-"))
		configTmpDir = mkdtempSync(join(tmpdir(), "kimchi-config-"))
		configPath = join(configTmpDir, "config.json")

		process.env.PI_PACKAGE_DIR = PROJECT_ROOT
		process.env.KIMCHI_CLAUDE_HOME = claudeHome
		process.env.KIMCHI_CONFIG_PATH = configPath
	})

	afterEach(() => {
		logSpy.mockRestore()
		errSpy.mockRestore()

		// biome-ignore lint/performance/noDelete: env vars must actually be deleted, not set to "undefined"
		delete process.env.PI_PACKAGE_DIR
		// biome-ignore lint/performance/noDelete: env vars must actually be deleted, not set to "undefined"
		delete process.env.KIMCHI_CLAUDE_HOME
		// biome-ignore lint/performance/noDelete: env vars must actually be deleted, not set to "undefined"
		delete process.env.KIMCHI_CONFIG_PATH

		rmSync(claudeHome, { recursive: true, force: true })
		rmSync(configTmpDir, { recursive: true, force: true })
	})

	// ── WI-11: no-args / --help / unknown subcommand ──────────────────────────

	describe("WI-11: no-args / --help / unknown", () => {
		it("runPlugin([]) returns 1 and stderr contains usage", async () => {
			const code = await runPlugin([])
			expect(code).toBe(1)
			const messages = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
			expect(messages).toContain("Usage: kimchi plugin")
		})

		it("runPlugin(['--help']) returns 0 and stdout mentions subcommands", async () => {
			const code = await runPlugin(["--help"])
			expect(code).toBe(0)
			const printed = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
			expect(printed).toContain("list")
			expect(printed).toContain("enable")
			expect(printed).toContain("disable")
			expect(printed).toContain("refresh")
		})

		it("runPlugin(['-h']) returns 0", async () => {
			const code = await runPlugin(["-h"])
			expect(code).toBe(0)
		})

		it("runPlugin(['bogus-subcommand']) returns 2 and stderr mentions unknown subcommand", async () => {
			const code = await runPlugin(["bogus-subcommand"])
			expect(code).toBe(2)
			const messages = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
			expect(messages).toContain("unknown subcommand")
		})
	})

	// ── WI-12: kimchi plugin list ─────────────────────────────────────────────

	describe("WI-12: plugin list", () => {
		it("with empty state lists bundled plugins as disabled", async () => {
			const code = await runPlugin(["list"])
			expect(code).toBe(0)
			const printed = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
			expect(printed).toContain("orchestrator-workflows")
			expect(printed).toContain("docs-curator")
			expect(printed).toContain("disabled")
		})

		it("with orchestrator-workflows enabled shows 'enabled' for that plugin", async () => {
			writeFileSync(
				configPath,
				JSON.stringify({
					plugins: {
						"orchestrator-workflows": { enabled: true, source: "bundled" },
					},
				}),
			)

			const code = await runPlugin(["list"])
			expect(code).toBe(0)
			const printed = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
			expect(printed).toContain("enabled")
		})
	})

	// ── WI-13: kimchi plugin enable <name> ───────────────────────────────────

	describe("WI-13: plugin enable", () => {
		it("enable with no name returns 1 and stderr mentions 'name'", async () => {
			const code = await runPlugin(["enable"])
			expect(code).toBe(1)
			const messages = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
			expect(messages).toContain("name")
		})

		it("enable nonexistent plugin returns 1 and stderr mentions 'unknown plugin'", async () => {
			const code = await runPlugin(["enable", "nonexistent-plugin-xyz"])
			expect(code).toBe(1)
			const messages = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
			expect(messages).toContain("unknown plugin")
		})

		it("enable orchestrator-workflows returns 0 and creates symlinks", async () => {
			const code = await runPlugin(["enable", "orchestrator-workflows"])
			expect(code).toBe(0)

			// commands symlink should exist
			const commandsLink = join(claudeHome, "commands", "orchestrator-workflows")
			const commandsStat = lstatSync(commandsLink)
			expect(commandsStat.isSymbolicLink()).toBe(true)

			// agents symlink should exist
			const agentsLink = join(claudeHome, "agents", "orchestrator-workflows")
			const agentsStat = lstatSync(agentsLink)
			expect(agentsStat.isSymbolicLink()).toBe(true)

			// state file should have enabled: true
			const { readPluginState } = await import("../plugins/state.js")
			const state = readPluginState(configPath)
			expect(state["orchestrator-workflows"]?.enabled).toBe(true)
		})
	})

	// ── WI-14: kimchi plugin disable <name> ──────────────────────────────────

	describe("WI-14: plugin disable", () => {
		it("disable with no name returns 1 and stderr mentions 'name'", async () => {
			const code = await runPlugin(["disable"])
			expect(code).toBe(1)
			const messages = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
			expect(messages).toContain("name")
		})

		it("disable nonexistent plugin returns 1", async () => {
			const code = await runPlugin(["disable", "nonexistent-xyz"])
			expect(code).toBe(1)
		})

		it("enable then disable orchestrator-workflows removes symlinks and marks disabled", async () => {
			// First enable
			const enableCode = await runPlugin(["enable", "orchestrator-workflows"])
			expect(enableCode).toBe(0)

			// Verify symlinks exist
			const commandsLink = join(claudeHome, "commands", "orchestrator-workflows")
			const agentsLink = join(claudeHome, "agents", "orchestrator-workflows")
			expect(lstatSync(commandsLink).isSymbolicLink()).toBe(true)
			expect(lstatSync(agentsLink).isSymbolicLink()).toBe(true)

			// Now disable
			const disableCode = await runPlugin(["disable", "orchestrator-workflows"])
			expect(disableCode).toBe(0)

			// Symlinks should no longer exist
			expect(() => lstatSync(commandsLink)).toThrow()
			expect(() => lstatSync(agentsLink)).toThrow()

			// State should have enabled: false
			const { readPluginState } = await import("../plugins/state.js")
			const state = readPluginState(configPath)
			expect(state["orchestrator-workflows"]?.enabled).toBe(false)
		})
	})

	// ── WI-15: kimchi plugin refresh ─────────────────────────────────────────

	describe("WI-15: plugin refresh", () => {
		it("refresh with no enabled plugins returns 0 and mentions 0 plugins or 'No plugins'", async () => {
			const code = await runPlugin(["refresh"])
			expect(code).toBe(0)
			const printed = [
				...logSpy.mock.calls.map((c) => String(c[0] ?? "")),
				...errSpy.mock.calls.map((c) => String(c[0] ?? "")),
			].join("\n")
			// Should mention either "No plugins" or "0" somewhere meaningful
			expect(printed.toLowerCase()).toMatch(/no plugins|0 plugin/)
		})

		it("refresh with orchestrator-workflows enabled re-creates symlinks and mentions the plugin", async () => {
			writeFileSync(
				configPath,
				JSON.stringify({
					plugins: {
						"orchestrator-workflows": { enabled: true, source: "bundled" },
					},
				}),
			)

			const code = await runPlugin(["refresh"])
			expect(code).toBe(0)

			// symlinks should now exist
			const commandsLink = join(claudeHome, "commands", "orchestrator-workflows")
			const agentsLink = join(claudeHome, "agents", "orchestrator-workflows")
			expect(lstatSync(commandsLink).isSymbolicLink()).toBe(true)
			expect(lstatSync(agentsLink).isSymbolicLink()).toBe(true)

			// stdout should mention the plugin name
			const printed = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n")
			expect(printed).toContain("orchestrator-workflows")
		})
	})
})
