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

			// Collapsed: a single dim summary naming the count and the tie-break
			// rule. The full collision listing must NOT be rendered.
			await waitForText(terminal, "1 skill conflict", { full: true })
			await waitForText(terminal, "the first one found is used", { full: true })
			expect(fullText(terminal)).not.toContain("[Skill conflicts]")

			// ctrl+o (app.tools.expand) expands to the full detail: header plus
			// winner/skipped lines.
			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "[Skill conflicts]", { full: true })
			await waitForText(terminal, "(skipped)", { full: true })
		},
	)
})
