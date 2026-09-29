import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function writeSharedSkill(dir: string): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, "SKILL.md"),
		[
			"---",
			"name: shared-skill",
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
