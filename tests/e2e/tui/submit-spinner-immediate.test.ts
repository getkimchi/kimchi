import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("the working spinner shows while pre-request hooks park the first turn", async ({ terminal }) => {
	// An extension whose before_agent_start parks for 2 s — the same shape
	// as the memory digest's bounded first-turn wait. Upstream first shows
	// the working spinner at turn_start, which only fires after every
	// before_agent_start hook completes; the spinner must be on screen
	// while the hook is still parked, or the parked window reads as a
	// frozen terminal.
	const dir = mkdtempSync(join(tmpdir(), "kimchi-spinner-"))
	const extensionPath = join(dir, "slow-start.mjs")
	writeFileSync(
		extensionPath,
		[
			"export default function slowStart(pi) {",
			"  pi.on('before_agent_start', async () => {",
			"    await new Promise((resolve) => setTimeout(resolve, 2000))",
			"  })",
			"}",
		].join("\n"),
	)

	await runKimchiSession(
		terminal,
		{
			artifactName: "submit-spinner-immediate",
			responses: [{ stream: ["Spun", " through."] }],
			extraArgs: ["--extension", extensionPath],
		},
		async () => {
			terminal.submit("say hi slowly")

			// Well inside the 2 s the hook is still parked for — on an
			// unpatched build the spinner cannot appear before turn_start.
			await expect(terminal.getByText("Working")).toBeVisible({ timeout: 1200 })

			// The turn completes once the hook releases and the response
			// streams; the spinner is gone by the time the answer lands.
			await expect(terminal.getByText("Spun through.", { full: true })).toBeVisible()
			await expect(terminal.getByText("Working")).not.toBeVisible()
		},
	)
})
