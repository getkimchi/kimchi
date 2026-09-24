import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { stripFrontmatter } from "@earendil-works/pi-coding-agent"
import { expect, test } from "@microsoft/tui-test"
import { REPO_ROOT, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("a user can invoke the bundled skill creator without installing skills", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "create-skill",
			responses: [{ stream: ["Let's create your meeting follow-up skill."] }],
		},
		async (fixture, trace) => {
			terminal.submit("/skill:create-skill Turn meeting notes into action items")
			trace.step("invoked bundled creator")

			await expect(terminal.getByText("Let's create your meeting follow-up skill.", { full: true })).toBeVisible()
			trace.step("creator request answered")

			const request = fixture.fake.requests.find((item) => item.url.startsWith("/openai/v1/chat/completions"))
			expect(request).toBeDefined()
			const body = JSON.stringify(request?.body)
			const skill = readFileSync(join(REPO_ROOT, "resources/skills/create-skill/SKILL.md"), "utf8")
			expect(body).toContain(JSON.stringify(stripFrontmatter(skill).trim()).slice(1, -1))
			expect(body).toContain("Turn meeting notes into action items")
		},
	)
})

for (const scope of ["project", "personal"] as const) {
	test(`a user can reload and invoke a newly saved ${scope} skill`, async ({ terminal }) => {
		await runKimchiSession(
			terminal,
			{
				artifactName: `create-skill-reload-${scope}`,
				trustWorkDir: true,
				responses: [{ stream: ["Meeting actions are ready."] }],
			},
			async (fixture, trace) => {
				const skillDir =
					scope === "project"
						? join(fixture.workDir, ".kimchi", "skills", "meeting-actions")
						: join(fixture.homeDir, ".config", "kimchi", "harness", "skills", "meeting-actions")
				const instructions = "Extract meeting actions; mark missing owners and dates as unspecified."
				mkdirSync(skillDir, { recursive: true })
				writeFileSync(
					join(skillDir, "SKILL.md"),
					`---\nname: meeting-actions\ndescription: Extract action items from meeting notes.\n---\n\n${instructions}\n`,
				)
				trace.step("saved skill after session startup")

				terminal.submit("/reload")
				await expect(terminal.getByText("Reloaded keybindings, extensions, skills")).toBeVisible()
				trace.step("reloaded newly saved skill")

				terminal.submit("/skill:meeting-actions Prepare a launch checklist")
				await expect(terminal.getByText("Meeting actions are ready.", { full: true })).toBeVisible()
				trace.step("invoked newly discovered skill")

				const request = fixture.fake.requests.find((item) => item.url.startsWith("/openai/v1/chat/completions"))
				expect(request).toBeDefined()
				const body = JSON.stringify(request?.body)
				expect(body).toContain(instructions)
				expect(body).toContain("Prepare a launch checklist")
			},
		)
	})
}
