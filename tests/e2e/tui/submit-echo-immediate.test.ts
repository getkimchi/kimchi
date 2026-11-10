import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("submitted message echoes before pre-request hooks finish", async ({ terminal }) => {
	// An extension whose before_agent_start parks for 2 s — the same shape as
	// the memory digest that held the user's message echo hostage between
	// Enter and the screen (the session only appends — and therefore renders —
	// the user entry after every before_agent_start hook completes). The echo
	// must paint while the hook is still parked: that can only be the
	// optimistic echo, reconciled when the real entry lands later.
	const dir = mkdtempSync(join(tmpdir(), "kimchi-echo-"))
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
			artifactName: "submit-echo-immediate",
			responses: [{ stream: ["Echoed", " back."] }],
			extraArgs: ["--extension", extensionPath],
		},
		async () => {
			terminal.submit("say hi quickly")

			// Well inside the 2 s the hook is still parked for — on an
			// unpatched build the echo cannot appear before the hook completes.
			await expect(terminal.getByText("say hi quickly")).toBeVisible({ timeout: 1200 })

			// The turn completes once the hook releases and the response
			// streams; the real entry replaced the optimistic one, so exactly
			// one echo bubble of the submitted text remains on screen.
			await expect(terminal.getByText("Echoed back.", { full: true })).toBeVisible()
			await expect(terminal.getByText("say hi quickly")).toBeVisible()
		},
	)
})

test("extension command submits never get an optimistic echo", async ({ terminal }) => {
	// Extension commands (kimchi's /help and friends) fall through to the
	// normal submit path but session.prompt executes them without appending a
	// user entry — an echo would render a ghost bubble that nothing ever
	// reconciles.
	await runKimchiSession(
		terminal,
		{ artifactName: "submit-echo-no-command-ghost", responses: [{ stream: ["unused"] }] },
		async () => {
			terminal.submit("/help")
			// Give any (wrong) echo time to render — then assert it never did.
			await new Promise((resolve) => setTimeout(resolve, 800))
			await expect(terminal.getByText("/help")).not.toBeVisible()
		},
	)
})

test("hook display messages survive the echo reconcile", async ({ terminal }) => {
	// The pre-request window is exactly when before_agent_start hooks run; one
	// that surfaces a displayed message must keep it after the echo clears —
	// the echo removes only its own components, never everything appended
	// after it.
	const dir = mkdtempSync(join(tmpdir(), "kimchi-echo-display-"))
	const extensionPath = join(dir, "display-start.mjs")
	writeFileSync(
		extensionPath,
		[
			"export default function displayStart(pi) {",
			"  pi.on('before_agent_start', async () => {",
			"    pi.sendMessage({",
			"      customType: 'window-notice',",
			"      content: [{ type: 'text', text: 'hook window notice' }],",
			"      display: true,",
			"    })",
			"    await new Promise((resolve) => setTimeout(resolve, 2000))",
			"  })",
			"}",
		].join("\n"),
	)

	await runKimchiSession(
		terminal,
		{
			artifactName: "submit-echo-display-survives",
			responses: [{ stream: ["Done", " after", " hook."] }],
			extraArgs: ["--extension", extensionPath],
		},
		async () => {
			terminal.submit("plain prompt")
			// The echo paints during the parked hook...
			await expect(terminal.getByText("plain prompt")).toBeVisible({ timeout: 1200 })
			// ...and the hook's display message lands after it.
			await expect(terminal.getByText("hook window notice")).toBeVisible()
			// Turn completes; the echo cleared by identity, the notice stays.
			await expect(terminal.getByText("Done after hook.", { full: true })).toBeVisible()
			await expect(terminal.getByText("hook window notice")).toBeVisible()
		},
	)
})
