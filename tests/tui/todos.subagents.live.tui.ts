import { test } from "@microsoft/tui-test"
import { createKimchiTuiContext, expectHidden, expectVisible, typeAndSubmit, useKimchiTui, waitForPrompt } from "./harness.js"

const liveEnabled =
	process.env.KIMCHI_TUI_LIVE_LLM === "1" &&
	process.env.KIMCHI_TUI_LIVE_SUBAGENTS === "1" &&
	!!process.env.KIMCHI_API_KEY
const context = createKimchiTuiContext("todos-subagents-live", {
	apiKey: process.env.KIMCHI_API_KEY,
})
useKimchiTui(context)

const SUBAGENT_LIVE_TIMEOUT = 7 * 60_000

test.when(liveEnabled, "live subagent private todos render inside the parent todo panel", async ({ terminal }) => {
	await waitForPrompt(terminal)

	await typeAndSubmit(
		terminal,
		[
			"Spawn one General-Purpose subagent with description \"SWR badge cache\".",
			"In the subagent prompt, explicitly instruct it to call write_todos with exactly one in_progress todo whose content is \"inspect SWR cache handoff\", then stop without editing files.",
			"Do not create parent/global todos. Wait for the subagent result, then stop.",
		].join(" "),
	)

	await expectVisible(terminal, "Subagent work", SUBAGENT_LIVE_TIMEOUT)
	await expectVisible(terminal, "SWR badge cache", SUBAGENT_LIVE_TIMEOUT)
	await expectVisible(terminal, "inspect SWR cache handoff", SUBAGENT_LIVE_TIMEOUT)
	await expectHidden(terminal, "Todos · Agent")
})
