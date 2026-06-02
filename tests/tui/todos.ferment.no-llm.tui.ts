import { Key, test } from "@microsoft/tui-test"
import {
	assertPersistedFermentStepTodos,
	assertSeededFermentStepStillRunning,
	createKimchiTuiContext,
	expectHidden,
	expectVisible,
	loadSeededFermentWithoutResume,
	useKimchiTui,
} from "./harness.js"

const ferment = {
	id: "ferment-tui-no-llm",
	name: "Seeded no-LLM TUI ferment",
	phaseId: "phase-1",
	stepId: "step-1",
}

const context = createKimchiTuiContext("todos-ferment-no-llm", {
	initialArgs: ["/todos add verify ferment scoped tactical todo"],
	seedFerment: ferment,
})
useKimchiTui(context)

test("active Ferment step shows tactical todos without submitting an LLM prompt", async ({ terminal }) => {
	await loadSeededFermentWithoutResume(terminal, ferment.name)

	await expectVisible(terminal, "Tactical work", 45_000)
	await expectVisible(terminal, `Ferment ${ferment.id} · Phase ${ferment.phaseId} · Step ${ferment.stepId}`)
	await expectVisible(terminal, "verify ferment scoped tactical todo")
	await expectVisible(terminal, "0/1 done · 1 active")
	await expectHidden(terminal, "Todos · Global")
	assertPersistedFermentStepTodos(context, ferment, {
		contentIncludes: "verify ferment scoped tactical todo",
		pending: 1,
		total: 1,
	})
	assertSeededFermentStepStillRunning(context, ferment)

	terminal.keyPress(Key.F7)
	await expectHidden(terminal, "Tactical work")

	terminal.keyPress(Key.F7)
	await expectVisible(terminal, "Tactical work")
	await expectVisible(terminal, "verify ferment scoped tactical todo")
})
