import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Shell, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function writeSharedSkill(dir: string, name = "shared-skill"): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, "SKILL.md"),
		[
			"---",
			`name: ${name}`,
			"description: Same skill name in two roots to force a collision.",
			"---",
			"",
			"Body.",
			"",
		].join("\n"),
		"utf-8",
	)
}

// Missing description → skill fails validation, is not loaded at all, and is
// reported as a skill *issue* (not a collision).
function writeBrokenSkill(dir: string): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "SKILL.md"), ["---", "name: broken-skill", "---", "", "Body.", ""].join("\n"), "utf-8")
}

test("skill conflicts render as a calm one-line summary that expands via ctrl+o", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skill-conflicts-summary",
			responses: [{ stream: ["Done."] }],
			seedHome: (homeDir) => {
				// Harness skill (wins — pi loads the agent dir first).
				writeSharedSkill(join(homeDir, ".config", "kimchi", "harness", "skills", "shared-skill"))
				// User agents-convention skill (same name — loses the collision).
				// Mirrors the startup screenshot: ~/.agents/skills loses to the
				// harness dir and is reported as skipped.
				writeSharedSkill(join(homeDir, ".agents", "skills", "shared-skill"))
			},
		},
		async () => {
			await waitForText(terminal, PROMPT_READY, { full: true })

			// Collapsed: a single dim summary explaining the conflicts. The full
			// collision listing must NOT be rendered. The right-aligned hint
			// matches the collapsed tool-row convention.
			await waitForText(terminal, "[1 skill conflict]", { full: true })
			await waitForText(terminal, "Some skills were found in multiple directories.", { full: true })
			await waitForText(terminal, "(ctrl+o to expand)", { full: true })
			expect(fullText(terminal)).not.toContain("[Skill conflicts]")

			// ctrl+o (app.tools.expand) expands to the full detail: header plus
			// winner/skipped lines.
			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "[Skill conflicts]", { full: true })
			await waitForText(terminal, "(ctrl+o to collapse)", { full: true })
			await waitForText(terminal, "(skipped)", { full: true })
		},
	)
})

test("skill issues are listed first in the summary, conflicts trail as 'Also'", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skill-issues-and-conflicts-summary",
			responses: [{ stream: ["Done."] }],
			seedHome: (homeDir) => {
				writeSharedSkill(join(homeDir, ".config", "kimchi", "harness", "skills", "shared-skill"))
				writeSharedSkill(join(homeDir, ".agents", "skills", "shared-skill"))
				writeBrokenSkill(join(homeDir, ".config", "kimchi", "harness", "skills", "broken-skill"))
			},
		},
		async () => {
			await waitForText(terminal, PROMPT_READY, { full: true })

			// Issues (not loaded) come first; conflicts (winner loaded) trail.
			await waitForText(terminal, "[1 skill issue] Some skills were not loaded.", { full: true })
			// 120-col terminal: the hint keeps its width, the summary truncates —
			// the "(a winner was loaded)" tail is the part that gets cut.
			await waitForText(terminal, "Also: 1 skill conflict in multiple directories", { full: true })
			await waitForText(terminal, "(ctrl+o to expand)", { full: true })

			// Expanded detail covers both the failure reason and the collision.
			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "[Skill conflicts]", { full: true })
			await waitForText(terminal, "description is required", { full: true })
			await waitForText(terminal, "(skipped)", { full: true })
		},
	)
})

test("skill issues without conflicts suppress the 'Also' clause", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skill-issues-only-summary",
			responses: [{ stream: ["Done."] }],
			seedHome: (homeDir) => {
				writeBrokenSkill(join(homeDir, ".config", "kimchi", "harness", "skills", "broken-skill"))
			},
		},
		async () => {
			await waitForText(terminal, PROMPT_READY, { full: true })

			await waitForText(terminal, "[1 skill issue] Some skills were not loaded.", { full: true })
			expect(fullText(terminal)).not.toContain("skill conflict")
			expect(fullText(terminal)).not.toContain("Also:")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "description is required", { full: true })
		},
	)
})

// Regression test for the ctrl+o crash on the startup skill-conflicts panel:
// in a narrow terminal the winner/skipped path lines rendered wider than the
// terminal, pi-tui's renderer threw "Rendered line N exceeds terminal width"
// as an uncaughtException, and the process died (user report: "Ctrl+O crashes
// session"). This test drives that exact scenario: a 60-column terminal,
// conflict paths that exceed the width even when ~-abbreviated, then ctrl+o.
test.describe("narrow terminal", () => {
	test.use({ shell: Shell.Bash, rows: 40, columns: 60 })

	test("expanding the panel with over-wide detail lines does not crash the session", async ({ terminal }) => {
		const longName = "shared-skill-with-an-extraordinarily-long-name"
		await runKimchiSession(
			terminal,
			{
				artifactName: "skill-conflicts-narrow-width",
				responses: [{ stream: ["SESSION-ALIVE-AFTER-EXPAND"] }],
				seedHome: (homeDir) => {
					writeSharedSkill(join(homeDir, ".config", "kimchi", "harness", "skills", longName), longName)
					writeSharedSkill(join(homeDir, ".agents", "skills", longName), longName)
				},
			},
			async () => {
				await waitForText(terminal, PROMPT_READY, { full: true })

				terminal.keyPress("o", { ctrl: true })
				await waitForText(terminal, "[Skill conflicts]", { full: true })
				// Crash signature: pi-tui's renderer throws on the overflowing line
				// and the process writes this to stderr before dying.
				expect(fullText(terminal)).not.toContain("exceeds terminal width")

				// The session must stay responsive after the expansion.
				terminal.submit("ping")
				await waitForText(terminal, "SESSION-ALIVE-AFTER-EXPAND", { full: true })
			},
		)
	})
})
