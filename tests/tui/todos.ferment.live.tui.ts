import { test } from "@microsoft/tui-test"
import {
	assertPersistedFermentStepTodos,
	assertSeededFermentStepStillRunning,
	createKimchiTuiContext,
	expectHidden,
	expectVisible,
	loadSeededFermentWithoutResume,
	typeAndSubmit,
	useKimchiTui,
	waitForPrompt,
} from "./harness.js"

const liveEnabled = process.env.KIMCHI_TUI_LIVE_LLM === "1" && !!process.env.KIMCHI_API_KEY
const ferment = {
	id: "ferment-tui-live",
	name: "Seeded live TUI ferment",
	phaseId: "phase-1",
	stepId: "step-1",
}
const context = createKimchiTuiContext("todos-ferment-live", {
	apiKey: process.env.KIMCHI_API_KEY,
	seedFerment: ferment,
})
useKimchiTui(context)

test.when(liveEnabled, "live LLM prompt creates Ferment step tactical todos", async ({ terminal }) => {
	await loadSeededFermentWithoutResume(terminal, ferment.name)
	await waitForPrompt(terminal)

	await typeAndSubmit(
		terminal,
		"Do not inspect files or run commands. Immediately call write_todos for the current active Ferment step with exactly 10 items: one in_progress, one blocked, two completed, and the rest pending. Omit the scope field so it uses the active Ferment step. Then stop without completing the Ferment step or changing Ferment state.",
	)

	await expectVisible(terminal, "Tactical work", 180_000)
	await expectVisible(terminal, `Ferment ${ferment.id} · Phase ${ferment.phaseId} · Step ${ferment.stepId}`, 180_000)
	await expectVisible(terminal, "2/10 done · 8 active · 1 blocked", 180_000)
	await expectHidden(terminal, "Todos · Global")
	assertPersistedFermentStepTodos(context, ferment, {
		blocked: 1,
		completed: 2,
		inProgress: 1,
		pending: 6,
		total: 10,
	})
	assertSeededFermentStepStillRunning(context, ferment)
})
