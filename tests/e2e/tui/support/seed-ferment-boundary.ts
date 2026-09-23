// Run under tsx: the TUI runner only transpiles files inside its own test directory.
import { mkdirSync, realpathSync } from "node:fs"
import { commandToEvents } from "../../../../src/ferment/event-mapper.js"
import { FermentEventStore } from "../../../../src/ferment/event-store.js"
import { applyCommand, type Command } from "../../../../src/ferment/state-machine.js"

const [dir, workDir] = process.argv.slice(2)
mkdirSync(dir, { recursive: true })
const store = new FermentEventStore(dir)
const ferment = store.create("Progress boundary regression")
const command = (cmd: Command) =>
	store.mutateWithEvents(ferment.id, (before) => {
		const now = new Date().toISOString()
		const result = applyCommand(before, cmd, { now })
		if (!result.ok) throw new Error(result.error.message)
		return {
			write: true,
			ferment: result.ferment,
			events: commandToEvents(cmd, before, result.ferment, { now }),
			value: undefined,
		}
	})

command({
	type: "scope",
	goal: "Continue after grading",
	phases: [
		{ name: "First phase", goal: "Finish work", steps: [{ description: "Completed step", verify: "true" }] },
		{ name: "Second phase", goal: "Continue work", steps: [{ description: "Next step", verify: "true" }] },
	],
})
store.updateWorktree(ferment.id, { path: realpathSync(workDir) })
command({ type: "activate_phase", phaseId: "phase-1" })
command({ type: "start_step", phaseId: "phase-1", stepId: "step-1" })
command({ type: "complete_step", phaseId: "phase-1", stepId: "step-1", summary: "Fixture completed" })
process.stdout.write(ferment.id)
