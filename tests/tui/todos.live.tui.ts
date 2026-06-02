import { test } from "@microsoft/tui-test"
import { createKimchiTuiContext, expectVisible, typeAndSubmit, useKimchiTui, waitForPrompt } from "./harness.js"

const liveEnabled = process.env.KIMCHI_TUI_LIVE_LLM === "1" && !!process.env.KIMCHI_API_KEY
const context = createKimchiTuiContext("todos-live", {
	apiKey: process.env.KIMCHI_API_KEY,
})
useKimchiTui(context)

test.when(liveEnabled, "live LLM prompt creates the expected todo board", async ({ terminal }) => {
	await waitForPrompt(terminal)

	await typeAndSubmit(
		terminal,
		"Research this project and create a tactical todo list for improvements. Use write_todos with 10 items: one in_progress, one blocked, two completed, and the rest pending. Then stop without doing the todos.",
	)

	await expectVisible(terminal, "Todos · Global", 180_000)
	await expectVisible(terminal, "2/10 done · 8 active · 1 blocked", 180_000)
})
