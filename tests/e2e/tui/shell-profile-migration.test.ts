import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { platform } from "node:os"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const MIGRATION_PROMPT = "We detected KIMCHI_API_KEY in your shell profile. Do you want to remove it?"
const MANUAL_PROMPT = "Possible old API key in"
const PROFILE_NAME = platform() === "darwin" ? ".bash_profile" : ".bashrc"
const EXIT_MARKER = "KIMCHI_MIGRATION_SESSION_EXITED"
const PROFILE = "# shell config\nexport KIMCHI_API_KEY=legacy-test-key\nexport KEEP_ME=unchanged\n"

function seedProfile(homeDir: string) {
	writeFileSync(join(homeDir, PROFILE_NAME), PROFILE)
	return { env: { SHELL: "/bin/bash" } }
}

test("API key mismatch warning appears only after answering the migration dialog", async ({ terminal }) => {
	const warning = "KIMCHI_API_KEY differs from your saved key. Using the environment key."
	await runKimchiSession(
		terminal,
		{
			artifactName: "shell-profile-migration-warning",
			startupText: MIGRATION_PROMPT,
			responses: [{ stream: ["Ready after migration."] }],
			seedHome(homeDir) {
				seedProfile(homeDir)
				return { env: { SHELL: "/bin/bash", KIMCHI_API_KEY: "legacy-test-key" } }
			},
		},
		async (_fixture, trace) => {
			expect(fullText(terminal)).not.toContain(warning)
			trace.step("migration dialog is visible without the mismatch warning")
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, warning)
			await waitForText(terminal, PROMPT_READY, { full: false })
			trace.step("answering No displays the mismatch warning and opens the prompt")
		},
	)
})

test("Yes removes the legacy key while preserving valid Bash startup and other settings", async ({ terminal }) => {
	const profileName = PROFILE_NAME
	const settings = [
		`if [ -r "\${XDG_CACHE_HOME:-$HOME/.cache}/prompt.sh" ]; then`,
		`  source "\${XDG_CACHE_HOME:-$HOME/.cache}/prompt.sh"`,
		"fi",
		"plugins=(",
		"  git",
		"  node",
		")",
		'eval "$(mise activate bash)"',
		'[[ ! -f "$HOME/.shell-extra" ]] || source "$HOME/.shell-extra"',
		"export KEEP_ME=unchanged",
		"",
	].join("\n")
	await runKimchiSession(
		terminal,
		{
			artifactName: "shell-profile-migration-remove",
			startupText: MIGRATION_PROMPT,
			exitMarker: EXIT_MARKER,
			responses: [{ stream: ["Ready after migration."] }],
			seedHome(homeDir) {
				writeFileSync(join(homeDir, profileName), `${settings}export KIMCHI_API_KEY=legacy-test-key\n`)
				return { env: { SHELL: "/bin/bash" } }
			},
		},
		async (fixture, trace) => {
			expect(fullText(terminal)).not.toContain("legacy-test-key")
			expect(fullText(terminal)).toContain(join(fixture.homeDir, profileName))
			trace.step("migration offers removal without displaying the key")
			terminal.submit("")
			await waitForText(terminal, PROMPT_READY, { full: false })
			await waitForText(terminal, "Removed KIMCHI_API_KEY from")
			const profilePath = join(fixture.homeDir, profileName)
			expect(readFileSync(profilePath, "utf-8")).toBe(settings)
			execFileSync("bash", ["--noprofile", "--norc", "-n", profilePath])
			trace.step("Yes removed the export and left a valid Bash profile with unrelated settings intact")

			terminal.submit("/quit")
			await waitForText(terminal, EXIT_MARKER, { full: false })
			launchKimchi(terminal, fixture, [], fixture.seedEnv)
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(viewText(terminal)).not.toContain(MIGRATION_PROMPT)
			terminal.submit("Say hello")
			await waitForText(terminal, "Ready after migration.")
			trace.step("next launch skipped migration and completed a chat turn")
		},
	)
})

test("an export inside a Bash block gets manual cleanup instructions and chat remains usable", async ({ terminal }) => {
	const profileName = PROFILE_NAME
	const content = "if true; then\n  export KIMCHI_API_KEY=legacy-test-key\nfi\n"
	await runKimchiSession(
		terminal,
		{
			artifactName: "shell-profile-migration-complex",
			startupText: MANUAL_PROMPT,
			responses: [{ stream: ["Chat works with the profile unchanged."] }],
			seedHome(homeDir) {
				writeFileSync(join(homeDir, profileName), content)
				return { env: { SHELL: "/bin/bash" } }
			},
		},
		async (fixture, trace) => {
			const profilePath = join(fixture.homeDir, profileName)
			expect(fullText(terminal)).toContain(profilePath)
			expect(fullText(terminal)).toContain("export KIMCHI_API_KEY=...")
			expect(fullText(terminal)).not.toContain("legacy-test-key")
			expect(fullText(terminal)).not.toContain(MIGRATION_PROMPT)
			await expect(terminal.getByText("Don't ask again")).toBeVisible()
			trace.step("manual instructions identify the profile without exposing the key")
			terminal.submit("")
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(readFileSync(profilePath, "utf-8")).toBe(content)
			execFileSync("bash", ["--noprofile", "--norc", "-n", profilePath])
			trace.step("OK opened the editor without changing the profile")
			terminal.submit("Say hello")
			await waitForText(terminal, "Chat works with the profile unchanged.")
			trace.step("chat completed while the original profile remained valid and unchanged")
		},
	)
})

test("manual cleanup reminders can be dismissed permanently", async ({ terminal }) => {
	const content = "examples=(\n  export KIMCHI_API_KEY=example\n)\n"
	await runKimchiSession(
		terminal,
		{
			artifactName: "shell-profile-migration-manual-dismiss",
			startupText: MANUAL_PROMPT,
			exitMarker: EXIT_MARKER,
			responses: [{ stream: ["Manual reminder dismissed."] }],
			seedHome(homeDir) {
				writeFileSync(join(homeDir, PROFILE_NAME), content)
				return { env: { SHELL: "/bin/bash" } }
			},
		},
		async (fixture, trace) => {
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(readFileSync(join(fixture.homeDir, PROFILE_NAME), "utf-8")).toBe(content)
			trace.step("Don't ask again preserved the array data")
			terminal.submit("/quit")
			await waitForText(terminal, EXIT_MARKER, { full: false })
			launchKimchi(terminal, fixture, [], fixture.seedEnv)
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(viewText(terminal)).not.toContain(MANUAL_PROMPT)
			expect(viewText(terminal)).not.toContain(MIGRATION_PROMPT)
			terminal.submit("Say hello")
			await waitForText(terminal, "Manual reminder dismissed.")
			trace.step("next launch completed chat without repeating the manual reminder")
		},
	)
})

test("No keeps the key and asks again on the next launch", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "shell-profile-migration-defer",
			startupText: MIGRATION_PROMPT,
			exitMarker: EXIT_MARKER,
			responses: [],
			seedHome: seedProfile,
		},
		async (fixture, trace) => {
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(readFileSync(join(fixture.homeDir, PROFILE_NAME), "utf-8")).toBe(PROFILE)
			trace.step("No kept the profile unchanged and opened the editor")

			terminal.submit("/quit")
			await waitForText(terminal, EXIT_MARKER, { full: false })
			launchKimchi(terminal, fixture, [], fixture.seedEnv)
			await waitForText(terminal, MIGRATION_PROMPT, { full: false })
			trace.step("next launch asked again")
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(readFileSync(join(fixture.homeDir, PROFILE_NAME), "utf-8")).toBe(PROFILE)
		},
	)
})

test("Don't ask again keeps the key and remembers the choice after restarting", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "shell-profile-migration-dismiss",
			startupText: MIGRATION_PROMPT,
			exitMarker: EXIT_MARKER,
			responses: [{ stream: ["Dismissal remembered."] }],
			seedHome: seedProfile,
		},
		async (fixture, trace) => {
			await expect(terminal.getByText("No, don't ask again")).toBeVisible()
			terminal.keyDown(2)
			terminal.submit("")
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(readFileSync(join(fixture.homeDir, PROFILE_NAME), "utf-8")).toBe(PROFILE)
			const settings = JSON.parse(readFileSync(join(fixture.agentDir, "settings.json"), "utf-8"))
			expect(settings.shellProfileApiKeyMigrationDismissed).toBe(true)
			expect(settings.hideThinkingBlock).toBe(true)
			trace.step("permanent dismissal saved without changing the profile or other settings")

			terminal.submit("/quit")
			await waitForText(terminal, EXIT_MARKER, { full: false })
			launchKimchi(terminal, fixture, [], fixture.seedEnv)
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(viewText(terminal)).not.toContain(MIGRATION_PROMPT)
			terminal.submit("Say hello")
			await waitForText(terminal, "Dismissal remembered.")
			trace.step("next launch opened the editor and completed chat without asking again")
		},
	)
})

test("profiles without a legacy export open the editor without a migration prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "shell-profile-migration-no-key",
			responses: [{ stream: ["No migration needed."] }],
			seedHome(homeDir) {
				writeFileSync(
					join(homeDir, PROFILE_NAME),
					'# export KIMCHI_API_KEY=commented-out\necho "$KIMCHI_API_KEY"\nexamples=(\n  KIMCHI_API_KEY=example\n)\n',
				)
				return { env: { SHELL: "/bin/bash" } }
			},
		},
		async (_fixture, trace) => {
			expect(viewText(terminal)).not.toContain(MIGRATION_PROMPT)
			expect(viewText(terminal)).not.toContain(MANUAL_PROMPT)
			terminal.submit("Say hello")
			await waitForText(terminal, "No migration needed.")
			trace.step("comments, references, and bare array elements did not trigger migration")
		},
	)
})

test("print mode leaves the shell profile untouched and completes without prompting", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "shell-profile-migration-print",
			startupText: "Print mode completed.",
			extraArgs: ["--print", "hello"],
			responses: [{ stream: ["Print mode completed."] }],
			seedHome: seedProfile,
		},
		async (fixture, trace) => {
			expect(fullText(terminal)).not.toContain(MIGRATION_PROMPT)
			expect(readFileSync(join(fixture.homeDir, PROFILE_NAME), "utf-8")).toBe(PROFILE)
			trace.step("noninteractive chat completed without touching the shell profile")
		},
	)
})
