/**
 * Phase-list editor — opens after `propose_scoping` so the user can rename,
 * reorder, edit goals, delete, or add phases before confirming.
 *
 * Returns the edited `ScopePhaseInput[]` on confirm, or `undefined` if the
 * user cancels. The caller passes the result to `confirmPendingScope`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { ScopePhaseInput } from "../../ferment/state-machine.js"
import { pr_bold, pr_dim, pr_teal, truncateLabel } from "./colors.js"
import type { FermentRuntime } from "./runtime.js"

type PhaseEditorContext = Partial<Pick<ExtensionContext, "ui">>
type PhaseEditorUi = NonNullable<PhaseEditorContext["ui"]>

const ADD_LABEL = "+ Add phase"
const CONFIRM_LABEL = "✓ Confirm and start"
const CANCEL_LABEL = "✗ Cancel"
const DIVIDER_LABEL = "─────────────"

function formatPhaseRow(p: ScopePhaseInput, idx: number): string {
	const goalSnippet = p.goal ? `  ${pr_dim("—")} ${truncateLabel(p.goal, 60)}` : ""
	return `${pr_teal(`${idx + 1}.`)} ${pr_bold(p.name)}${goalSnippet}`
}

async function editPhaseDetails(
	ui: PhaseEditorUi,
	phase: ScopePhaseInput,
	canMoveUp: boolean,
	canMoveDown: boolean,
	runtime?: FermentRuntime,
): Promise<{ action: "save" | "delete" | "moveUp" | "moveDown" | "back"; phase: ScopePhaseInput }> {
	const renameLabel = "Rename"
	const editGoalLabel = "Edit goal"
	const moveUpLabel = "Move up"
	const moveDownLabel = "Move down"
	const deleteLabel = "Delete phase"
	const backLabel = "Back"

	const options: string[] = [renameLabel, editGoalLabel]
	if (canMoveUp) options.push(moveUpLabel)
	if (canMoveDown) options.push(moveDownLabel)
	options.push(deleteLabel, backLabel)

	const title = `${pr_bold(phase.name)}\n${pr_dim(phase.goal || "(no goal)")}`
	const choice = await ui.select(title, options)
	runtime?.markHumanInput()

	if (!choice || choice === backLabel) return { action: "back", phase }

	if (choice === renameLabel && ui.input) {
		const next = await ui.input("Phase name:", phase.name)
		runtime?.markHumanInput()
		if (next?.trim()) return { action: "save", phase: { ...phase, name: next.trim() } }
		return { action: "back", phase }
	}

	if (choice === editGoalLabel && ui.input) {
		const next = await ui.input("Phase goal:", phase.goal ?? "")
		runtime?.markHumanInput()
		if (next !== undefined) return { action: "save", phase: { ...phase, goal: next.trim() } }
		return { action: "back", phase }
	}

	if (choice === moveUpLabel) return { action: "moveUp", phase }
	if (choice === moveDownLabel) return { action: "moveDown", phase }

	if (choice === deleteLabel) {
		const confirmed = ui.confirm
			? await ui.confirm(`Delete phase "${phase.name}"?`, "This cannot be undone within the editor.")
			: false
		runtime?.markHumanInput()
		if (confirmed) return { action: "delete", phase }
	}

	return { action: "back", phase }
}

async function addPhase(ui: PhaseEditorUi, runtime?: FermentRuntime): Promise<ScopePhaseInput | undefined> {
	if (!ui.input) return undefined
	const name = await ui.input("New phase name:", "")
	runtime?.markHumanInput()
	if (!name || !name.trim()) return undefined
	const goal = await ui.input("Phase goal:", "")
	runtime?.markHumanInput()
	return { name: name.trim(), goal: (goal ?? "").trim() }
}

export async function editPhaseProposal(
	ctx: PhaseEditorContext,
	phases: ScopePhaseInput[],
	runtime?: FermentRuntime,
): Promise<ScopePhaseInput[] | undefined> {
	const ui = ctx.ui
	if (!ui?.select) return phases

	let working: ScopePhaseInput[] = phases.map((p) => ({ ...p }))

	while (true) {
		const labelToIndex = new Map<string, number>()
		const phaseLabels = working.map((p, i) => {
			const label = formatPhaseRow(p, i)
			labelToIndex.set(label, i)
			return label
		})
		const options = [...phaseLabels, DIVIDER_LABEL, ADD_LABEL, CONFIRM_LABEL, CANCEL_LABEL]
		const title = `${pr_teal("🍺")} ${pr_bold("Review the proposed phases")}  ${pr_dim(`(${working.length} phase${working.length === 1 ? "" : "s"})`)}`
		const choice = await ui.select(title, options)
		runtime?.markHumanInput()

		if (!choice || choice === CANCEL_LABEL) return undefined
		if (choice === DIVIDER_LABEL) continue
		if (choice === CONFIRM_LABEL) {
			if (working.length === 0) {
				ui.notify("Add at least one phase before confirming.")
				continue
			}
			return working
		}
		if (choice === ADD_LABEL) {
			const next = await addPhase(ui, runtime)
			runtime?.markHumanInput()
			if (next) working.push(next)
			continue
		}

		const idx = labelToIndex.get(choice)
		if (idx === undefined) continue
		const canMoveUp = idx > 0
		const canMoveDown = idx < working.length - 1
		const result = await editPhaseDetails(ui, working[idx], canMoveUp, canMoveDown, runtime)
		runtime?.markHumanInput()
		if (result.action === "save") {
			working = working.map((p, i) => (i === idx ? result.phase : p))
		} else if (result.action === "delete") {
			working = working.filter((_, i) => i !== idx)
		} else if (result.action === "moveUp" && canMoveUp) {
			const swapped = [...working]
			;[swapped[idx - 1], swapped[idx]] = [swapped[idx], swapped[idx - 1]]
			working = swapped
		} else if (result.action === "moveDown" && canMoveDown) {
			const swapped = [...working]
			;[swapped[idx], swapped[idx + 1]] = [swapped[idx + 1], swapped[idx]]
			working = swapped
		}
	}
}
