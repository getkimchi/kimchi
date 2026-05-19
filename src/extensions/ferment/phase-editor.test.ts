import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { ScopePhaseInput } from "../../ferment/state-machine.js"
import { editPhaseProposal } from "./phase-editor.js"
import type { FermentRuntime } from "./runtime.js"

type PhaseEditorCtx = Partial<Pick<ExtensionContext, "ui">>

interface MockUi {
	select?: ReturnType<typeof vi.fn>
	input?: ReturnType<typeof vi.fn>
	confirm?: ReturnType<typeof vi.fn>
	notify?: ReturnType<typeof vi.fn>
}

function buildCtx(ui: MockUi | undefined): PhaseEditorCtx {
	return { ui } as unknown as PhaseEditorCtx
}

function makeRuntime(): FermentRuntime & { markHumanInput: ReturnType<typeof vi.fn> } {
	const markHumanInput = vi.fn()
	return { markHumanInput } as unknown as FermentRuntime & { markHumanInput: ReturnType<typeof vi.fn> }
}

const PHASES: ScopePhaseInput[] = [
	{ name: "Alpha", goal: "Build alpha" },
	{ name: "Beta", goal: "Build beta" },
	{ name: "Gamma", goal: "Build gamma" },
]

const ADD_LABEL = "+ Add phase"
const CONFIRM_LABEL = "✓ Confirm and start"
const CANCEL_LABEL = "✗ Cancel"

describe("editPhaseProposal", () => {
	it("returns the original phases when ui is undefined", async () => {
		const result = await editPhaseProposal(buildCtx(undefined), PHASES)
		expect(result).toEqual(PHASES)
	})

	it("returns the original phases when ui.select is missing", async () => {
		const ui: MockUi = { input: vi.fn(), confirm: vi.fn(), notify: vi.fn() }
		const result = await editPhaseProposal(buildCtx(ui), PHASES)
		expect(result).toEqual(PHASES)
	})

	it("returns undefined when the user cancels", async () => {
		const select = vi.fn().mockResolvedValueOnce(CANCEL_LABEL)
		const result = await editPhaseProposal(buildCtx({ select }), PHASES)
		expect(result).toBeUndefined()
		expect(select).toHaveBeenCalledTimes(1)
	})

	it("returns undefined when select resolves to undefined (dropdown dismissed)", async () => {
		const select = vi.fn().mockResolvedValueOnce(undefined)
		const result = await editPhaseProposal(buildCtx({ select }), PHASES)
		expect(result).toBeUndefined()
	})

	it("returns the working set untouched when the user picks confirm", async () => {
		const select = vi.fn().mockResolvedValueOnce(CONFIRM_LABEL)
		const result = await editPhaseProposal(buildCtx({ select }), PHASES)
		expect(result).toEqual(PHASES)
	})

	it("notifies and re-prompts when confirming an empty list", async () => {
		const select = vi.fn().mockResolvedValueOnce(CONFIRM_LABEL).mockResolvedValueOnce(CANCEL_LABEL)
		const notify = vi.fn()
		const result = await editPhaseProposal(buildCtx({ select, notify }), [])
		expect(result).toBeUndefined()
		expect(notify).toHaveBeenCalledWith("Add at least one phase before confirming.")
		expect(select).toHaveBeenCalledTimes(2)
	})

	it("appends a new phase via the add flow", async () => {
		const select = vi.fn().mockResolvedValueOnce(ADD_LABEL).mockResolvedValueOnce(CONFIRM_LABEL)
		const input = vi.fn().mockResolvedValueOnce("Delta").mockResolvedValueOnce("Build delta")
		const result = await editPhaseProposal(buildCtx({ select, input }), PHASES)
		expect(result).toEqual([...PHASES, { name: "Delta", goal: "Build delta" }])
	})

	it("skips adding when the name is blank", async () => {
		const select = vi.fn().mockResolvedValueOnce(ADD_LABEL).mockResolvedValueOnce(CONFIRM_LABEL)
		const input = vi.fn().mockResolvedValueOnce("   ")
		const result = await editPhaseProposal(buildCtx({ select, input }), PHASES)
		expect(result).toEqual(PHASES)
	})

	it("renames the selected phase", async () => {
		const select = vi
			.fn()
			.mockImplementationOnce(async (_title: string, options: string[]) => options[0])
			.mockResolvedValueOnce("Rename")
			.mockResolvedValueOnce(CONFIRM_LABEL)
		const input = vi.fn().mockResolvedValueOnce("Alpha Prime")
		const result = await editPhaseProposal(buildCtx({ select, input }), PHASES)
		expect(result?.[0]).toEqual({ name: "Alpha Prime", goal: "Build alpha" })
	})

	it("edits the selected phase goal", async () => {
		const select = vi
			.fn()
			.mockImplementationOnce(async (_title: string, options: string[]) => options[1])
			.mockResolvedValueOnce("Edit goal")
			.mockResolvedValueOnce(CONFIRM_LABEL)
		const input = vi.fn().mockResolvedValueOnce("Polish beta")
		const result = await editPhaseProposal(buildCtx({ select, input }), PHASES)
		expect(result?.[1]).toEqual({ name: "Beta", goal: "Polish beta" })
	})

	it("moves the selected phase up", async () => {
		const select = vi
			.fn()
			.mockImplementationOnce(async (_title: string, options: string[]) => options[1])
			.mockResolvedValueOnce("Move up")
			.mockResolvedValueOnce(CONFIRM_LABEL)
		const result = await editPhaseProposal(buildCtx({ select }), PHASES)
		expect(result?.map((p) => p.name)).toEqual(["Beta", "Alpha", "Gamma"])
	})

	it("moves the selected phase down", async () => {
		const select = vi
			.fn()
			.mockImplementationOnce(async (_title: string, options: string[]) => options[0])
			.mockResolvedValueOnce("Move down")
			.mockResolvedValueOnce(CONFIRM_LABEL)
		const result = await editPhaseProposal(buildCtx({ select }), PHASES)
		expect(result?.map((p) => p.name)).toEqual(["Beta", "Alpha", "Gamma"])
	})

	it("deletes the selected phase when confirm returns true", async () => {
		const select = vi
			.fn()
			.mockImplementationOnce(async (_title: string, options: string[]) => options[1])
			.mockResolvedValueOnce("Delete phase")
			.mockResolvedValueOnce(CONFIRM_LABEL)
		const confirm = vi.fn().mockResolvedValueOnce(true)
		const result = await editPhaseProposal(buildCtx({ select, confirm }), PHASES)
		expect(result?.map((p) => p.name)).toEqual(["Alpha", "Gamma"])
	})

	it("keeps the phase when confirm returns false", async () => {
		const select = vi
			.fn()
			.mockImplementationOnce(async (_title: string, options: string[]) => options[1])
			.mockResolvedValueOnce("Delete phase")
			.mockResolvedValueOnce(CONFIRM_LABEL)
		const confirm = vi.fn().mockResolvedValueOnce(false)
		const result = await editPhaseProposal(buildCtx({ select, confirm }), PHASES)
		expect(result).toEqual(PHASES)
	})

	it("refuses delete when ui.confirm is missing (safe default)", async () => {
		const select = vi
			.fn()
			.mockImplementationOnce(async (_title: string, options: string[]) => options[1])
			.mockResolvedValueOnce("Delete phase")
			.mockResolvedValueOnce(CONFIRM_LABEL)
		const result = await editPhaseProposal(buildCtx({ select }), PHASES)
		expect(result).toEqual(PHASES)
	})

	it("calls runtime.markHumanInput after each interactive step", async () => {
		const select = vi
			.fn()
			.mockImplementationOnce(async (_title: string, options: string[]) => options[0])
			.mockResolvedValueOnce("Rename")
			.mockResolvedValueOnce(CONFIRM_LABEL)
		const input = vi.fn().mockResolvedValueOnce("Alpha Prime")
		const runtime = makeRuntime()
		await editPhaseProposal(buildCtx({ select, input }), PHASES, runtime)
		expect(runtime.markHumanInput.mock.calls.length).toBeGreaterThanOrEqual(3)
	})
})
