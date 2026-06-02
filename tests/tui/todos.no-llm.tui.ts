import { Key, test } from "@microsoft/tui-test"
import { createKimchiTuiContext, expectHidden, expectVisible, useKimchiTui, waitForPrompt } from "./harness.js"

const context = createKimchiTuiContext("todos-no-llm", {
	initialArgs: ["/todos add verify initial todo overlay"],
})
useKimchiTui(context)

test("todo overlay can be driven without submitting an LLM prompt", async ({ terminal }) => {
	await waitForPrompt(terminal)

	await expectVisible(terminal, "Todos · Global")
	await expectVisible(terminal, "verify initial todo overlay")
	await expectVisible(terminal, "0/1 done · 1 active")
	await expectVisible(terminal, "Esc/q/Enter/F7 to collapse")

	terminal.keyPress(Key.F7)
	await expectHidden(terminal, "Todos · Global")

	terminal.keyPress(Key.F7)
	await expectVisible(terminal, "Todos · Global")
	await expectVisible(terminal, "verify initial todo overlay")
})
