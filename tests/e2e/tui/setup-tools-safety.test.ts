import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { parse } from "smol-toml"
import { fullText, waitForText } from "./support/assertions.js"
import { launchKimchi, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const oldSecret = "old-claude-secret-for-regression"
const newSecret = "new-kimchi-secret-for-regression"
const claudeOriginal = JSON.stringify({ theme: "dark", env: { ANTHROPIC_AUTH_TOKEN: oldSecret } })
const codexOriginal = '# My preferences\nmodel = "original"\napproval_policy = "on-request"\n'
const catalogOriginal = '{"models":[{"slug":"original"}]}\n'

for (const tool of ["Claude Code", "Codex"] as const) {
	for (const apply of [false, true]) {
		test(`setup-tools ${apply ? "backs up and applies" : "declines"} ${tool} changes without displaying credentials`, async ({
			terminal,
		}) => {
			await runKimchiSession(
				terminal,
				{
					artifactName: `setup-tools-${tool.replaceAll(" ", "-")}-${apply ? "apply" : "decline"}`,
					initialModel: false,
					extraArgs: ["setup-tools"],
					startupText: "Which tools should be configured?",
					responses: [],
					seedHome(homeDir) {
						const binDir = join(homeDir, "bin")
						mkdirSync(binDir)
						writeFileSync(join(binDir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
						const configPath = join(homeDir, ".config", "kimchi", "config.json")
						const config = JSON.parse(readFileSync(configPath, "utf8"))
						writeFileSync(configPath, JSON.stringify({ ...config, apiKey: newSecret, telemetry: { enabled: false } }))
						mkdirSync(join(homeDir, ".claude"))
						mkdirSync(join(homeDir, ".codex"))
						writeFileSync(join(homeDir, ".claude", "settings.json"), claudeOriginal)
						writeFileSync(join(homeDir, ".codex", "config.toml"), codexOriginal)
						writeFileSync(join(homeDir, ".codex", "model_catalog.json"), catalogOriginal)
						return { env: { PATH: binDir, KIMCHI_API_KEY: "", KIMCHI_TELEMETRY_ENABLED: "false" } }
					},
				},
				async (fixture, trace) => {
					// Clear detected defaults, then select the named tool in the visible menu.
					const options = fullText(terminal)
						.split("\n")
						.filter((line) => /[◻◼]/.test(line))
					const index = options.findIndex((line) => line.includes(tool))
					expect(index).toBeGreaterThanOrEqual(0)
					terminal.write("a")
					terminal.write("a")
					if (index > 0) terminal.keyDown(index)
					terminal.write(" ")
					terminal.submit("")

					const question =
						tool === "Claude Code"
							? "Apply these changes to Claude Code environment variables?"
							: "Apply these changes to Codex configuration?"
					await waitForText(terminal, question)
					const preview = fullText(terminal)
					expect(preview).not.toContain(oldSecret)
					expect(preview).not.toContain(newSecret)
					expect(preview).toContain("backed up before writing")
					if (tool === "Claude Code") {
						expect(preview).toContain("claude.ai connectors")
						expect(preview).toContain("[redacted]")
					} else {
						expect(preview).toContain("default model and provider")
					}
					trace.step("authentication change explained before writing, with credentials hidden")
					if (apply) terminal.keyLeft()
					terminal.submit("")
					await waitForText(terminal, apply ? `${tool}: configured` : `${tool}: skipped (configuration left unchanged)`)
					await waitForText(terminal, "Done.")
					if (!apply) {
						expect(fullText(terminal)).toContain(`Skipped: ${tool}`)
						expect(fullText(terminal)).not.toContain("Done with errors.")
						expect(fullText(terminal)).not.toContain(`${tool}: configured`)
					}

					const directory = join(fixture.homeDir, tool === "Claude Code" ? ".claude" : ".codex")
					const backups = readdirSync(directory).filter((name) => name.endsWith(".bak"))
					const configPath = join(directory, tool === "Claude Code" ? "settings.json" : "config.toml")
					if (apply) {
						expect(backups).toHaveLength(tool === "Claude Code" ? 1 : 2)
						expect(readFileSync(join(directory, backups[0]), "utf8")).toBe(
							tool === "Claude Code" ? claudeOriginal : codexOriginal,
						)
						expect(fullText(terminal)).toContain("Restore:")
						if (tool === "Claude Code") {
							expect(JSON.parse(readFileSync(configPath, "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe(newSecret)
						} else {
							expect(parse(readFileSync(configPath, "utf8")).approval_policy).toBe("on-request")
							expect(readFileSync(join(directory, backups[1]), "utf8")).toBe(catalogOriginal)
						}
					} else {
						expect(backups).toHaveLength(0)
						expect(readFileSync(configPath, "utf8")).toBe(tool === "Claude Code" ? claudeOriginal : codexOriginal)
					}
					expect(fullText(terminal)).not.toContain(newSecret)
					expect(fullText(terminal)).not.toContain(oldSecret)
					trace.step(
						apply
							? "original files backed up and restore instructions displayed"
							: "default No leaves original configuration intact",
					)
					if (apply && tool === "Codex") {
						// Reset the terminal after exit so the first menu cannot satisfy the next wait.
						terminal.submit("printf '\\033c%s\\n' 'REPEAT_SETUP_READY'")
						await waitForText(terminal, /^REPEAT_SETUP_READY$/m, { full: false })
						launchKimchi(terminal, fixture, ["setup-tools"], fixture.seedEnv)
						await waitForText(terminal, "Which tools should be configured?", { full: false })
						terminal.write("a")
						terminal.write("a")
						terminal.keyDown(index)
						terminal.write(" ")
						terminal.submit("")
						await waitForText(terminal, "Codex configuration is already up to date.")
						await waitForText(terminal, "Done.")
						expect(fullText(terminal)).not.toContain(question)
						expect(readdirSync(directory).filter((name) => name.endsWith(".bak"))).toEqual(backups)
						trace.step("repeated Codex setup completes without confirmation or additional backups")
					}
				},
			)
		})
	}
}
