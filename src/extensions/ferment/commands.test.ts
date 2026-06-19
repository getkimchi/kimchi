import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import {
	FermentCommandController,
	getFermentArgumentCompletions,
	registerFermentCommands,
	startInteractiveFerment,
} from "./commands.js"
import { maybeInjectReactiveContinuationNudge } from "./nudge.js"
import { clearAllPendingPlanReviews, getPendingPlanReview, setPendingPlanReview } from "./plan-review.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { createApplyAndPersist } from "./tool-helpers.js"

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		writeFileSync: vi.fn(actual.writeFileSync),
	}
})

const tipWidgetLocationMock = vi.hoisted(() => ({
	restore: vi.fn(),
	set: vi.fn(),
}))

const requestSharedFooterRenderMock = vi.hoisted(() => vi.fn())

vi.mock("../tips/index.js", () => ({
	setTipWidgetLocation: tipWidgetLocationMock.set,
}))

vi.mock("../shared-footer.js", () => ({
	requestSharedFooterRender: requestSharedFooterRenderMock,
}))

const writeFileSyncMock = vi.mocked(writeFileSync)
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs")

beforeEach(() => {
	tipWidgetLocationMock.restore.mockReset()
	tipWidgetLocationMock.set.mockReset()
	tipWidgetLocationMock.set.mockReturnValue(tipWidgetLocationMock.restore)
	requestSharedFooterRenderMock.mockReset()
})

afterEach(() => {
	writeFileSyncMock.mockReset()
	writeFileSyncMock.mockImplementation(actualFs.writeFileSync)
	clearAllPendingPlanReviews()
})

interface RegisteredCommand {
	getArgumentCompletions?: (
		prefix: string,
	) =>
		| Promise<Array<{ value: string; label: string; description?: string }> | null>
		| Array<{ value: string; label: string; description?: string }>
		| null
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>
}

function createHarness() {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-command-controller-test-")))
	const baseRuntime = createDefaultFermentRuntime()
	baseRuntime.setContinuationPolicy("manual")
	let activeRef: Ferment | undefined
	const runtime: FermentRuntime = {
		...baseRuntime,
		getStorage: () => storage,
		getActive: vi.fn(() => activeRef),
		getActiveId: vi.fn(() => activeRef?.id),
		setActive: vi.fn((ferment: Ferment | undefined) => {
			activeRef = ferment
		}),
	}
	let activeTools = ["read", "bash"]
	const allTools = [
		{ name: "read" },
		{ name: "bash" },
		{ name: "propose_ferment_scoping" },
		{ name: "start_ferment_step" },
	]
	const pi = {
		on: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		getActiveTools: vi.fn(() => activeTools),
		getAllTools: vi.fn(() => allTools),
		setActiveTools: vi.fn((names: string[]) => {
			activeTools = names
		}),
		events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
	} as unknown as ExtensionAPI
	const ctx = {
		hasUI: false,
		ui: { notify: vi.fn() },
		abort: vi.fn(),
		waitForIdle: vi.fn().mockResolvedValue(undefined),
	} as unknown as ExtensionCommandContext
	return { storage, runtime, pi, ctx }
}

type CommandHarness = ReturnType<typeof createHarness>

function createPlannedFerment(h: CommandHarness, name: string): Ferment {
	const ferment = h.storage.create(name)
	const scoped = createApplyAndPersist(h.runtime)(ferment.id, {
		type: "scope",
		goal: "Goal",
		successCriteria: ["Works"],
		constraints: [],
		phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
	})
	if (!scoped.ok) throw new Error(scoped.error.message)
	return scoped.ferment
}

function createRunningFerment(h: CommandHarness, name: string): Ferment {
	const planned = createPlannedFerment(h, name)
	const activated = createApplyAndPersist(h.runtime)(planned.id, { type: "activate_phase", phaseId: "phase-1" })
	if (!activated.ok) throw new Error(activated.error.message)
	return activated.ferment
}

function createPausedFerment(h: CommandHarness, name: string): Ferment {
	const planned = createPlannedFerment(h, name)
	const paused = createApplyAndPersist(h.runtime)(planned.id, { type: "pause" })
	if (!paused.ok) throw new Error(paused.error.message)
	return paused.ferment
}

function createCompleteFerment(h: CommandHarness, name: string): Ferment {
	const ferment = h.storage.create(name)
	const scoped = createApplyAndPersist(h.runtime)(ferment.id, {
		type: "scope",
		goal: "Goal",
		successCriteria: ["Works"],
		constraints: [],
		phases: [],
	})
	if (!scoped.ok) throw new Error(scoped.error.message)
	const completed = createApplyAndPersist(h.runtime)(scoped.ferment.id, { type: "complete_ferment" })
	if (!completed.ok) throw new Error(completed.error.message)
	return completed.ferment
}

describe("FermentCommandController", () => {
	it("executes new commands through injected runtime storage", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()

		const result = await controller.execute(
			{ type: "new", title: "Controller Test" },
			{ raw: 'new "Controller Test"', pi: h.pi, ctx: h.ctx, runtime: h.runtime },
		)

		const created = h.storage.list().find((f) => f.name === "Controller Test")
		expect(result).toEqual({ handled: true })
		expect(created).toBeDefined()
		expect(h.runtime.setActive).toHaveBeenCalledWith(expect.objectContaining({ id: created?.id }))
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [expect.objectContaining({ text: expect.stringContaining("Scope:") })],
			}),
			{ triggerTurn: true },
		)
		expect(h.ctx.waitForIdle).toHaveBeenCalledTimes(1)
	})

	it("accepts an inline new title without opening an editor in UI mode", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ui = {
			notify: vi.fn(),
			editor: vi.fn().mockResolvedValueOnce("unexpected editor text"),
			input: vi.fn().mockResolvedValueOnce("unexpected input text"),
		}
		const ctx = {
			hasUI: true,
			ui,
		} as unknown as ExtensionCommandContext

		const result = await controller.execute(
			{ type: "new", title: "Inline Title" },
			{ raw: 'new "Inline Title"', pi: h.pi, ctx, runtime: h.runtime },
		)

		const created = h.storage.list().find((f) => f.description === "Inline Title")
		expect(result).toEqual({ handled: true })
		expect(ui.editor).not.toHaveBeenCalled()
		expect(ui.input).not.toHaveBeenCalled()
		expect(created).toBeDefined()
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_created_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("Inline Title") })],
			}),
			{ triggerTurn: true },
		)
	})

	it("prompts bare new commands with the multi-line editor in UI mode", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ui = {
			notify: vi.fn(),
			editor: vi.fn().mockResolvedValueOnce("make reports better\ninclude tests"),
			input: vi.fn().mockResolvedValueOnce("single-line fallback"),
		}
		const ctx = {
			hasUI: true,
			ui,
		} as unknown as ExtensionCommandContext

		const result = await controller.execute(
			{ type: "new", title: "" },
			{ raw: "new", pi: h.pi, ctx, runtime: h.runtime },
		)

		const created = h.storage.list().find((f) => f.description === "make reports better\ninclude tests")
		expect(result).toEqual({ handled: true })
		expect(ui.editor).toHaveBeenCalledWith(
			"🍺  What would you like to ferment?\ne.g. 'Rewrite login flow' or 'Add OAuth support'",
			"",
		)
		expect(ui.input).not.toHaveBeenCalled()
		expect(created).toBeDefined()
		expect(h.runtime.setActive).toHaveBeenCalledWith(expect.objectContaining({ id: created?.id }))
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_request",
				display: true,
				details: { intent: "make reports better\ninclude tests" },
			}),
			{ triggerTurn: false },
		)
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_created_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("make reports better\ninclude tests") })],
			}),
			{ triggerTurn: true },
		)
	})

	it("echoes the interactive request before starting the hidden scoping turn", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ui = {
			notify: vi.fn(),
			editor: vi.fn().mockResolvedValueOnce("make the todo app glassy\nwith tests"),
			input: vi.fn().mockResolvedValueOnce("single-line fallback"),
			select: vi.fn(),
		}
		const ctx = {
			hasUI: true,
			ui,
		} as unknown as ExtensionCommandContext

		const result = await controller.execute({ type: "interactive" }, { raw: "", pi: h.pi, ctx, runtime: h.runtime })

		expect(result).toEqual({ handled: true })
		expect(ui.editor).toHaveBeenCalledWith(
			"🍺  What would you like to ferment?\ne.g. 'Rewrite login flow' or 'Add OAuth support'",
			"",
		)
		expect(ui.input).not.toHaveBeenCalled()
		expect(ui.select).not.toHaveBeenCalled()
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_request",
				display: true,
				details: { intent: "make the todo app glassy\nwith tests" },
			}),
			{ triggerTurn: false },
		)
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_created_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("make the todo app glassy\nwith tests") })],
			}),
			{ triggerTurn: true },
		)
	})

	it("exposes the interactive request flow as a reusable helper", async () => {
		const h = createHarness()
		const ui = {
			notify: vi.fn(),
			input: vi.fn().mockResolvedValueOnce("make settings searchable"),
			select: vi.fn(),
		}
		const ctx = {
			hasUI: true,
			ui,
		} as unknown as ExtensionCommandContext

		await startInteractiveFerment({ pi: h.pi, ctx, runtime: h.runtime })

		expect(tipWidgetLocationMock.set).toHaveBeenCalledWith("hidden")
		expect(tipWidgetLocationMock.restore).toHaveBeenCalled()
		expect(ui.select).not.toHaveBeenCalled()
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_request",
				display: true,
				details: { intent: "make settings searchable" },
			}),
			{ triggerTurn: false },
		)
		expect(h.runtime.setActive).toHaveBeenCalledWith(
			expect.objectContaining({ description: "make settings searchable" }),
		)
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_created_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("make settings searchable") })],
			}),
			{ triggerTurn: true },
		)
	})

	it("returns a structured handled result for headless list output", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		h.storage.create("Existing")

		const result = await controller.execute({ type: "list" }, { raw: "list", pi: h.pi, ctx: h.ctx, runtime: h.runtime })

		expect(result).toEqual({ handled: true })
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Existing"))
	})

	it("reports unknown commands without creating a ferment", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()

		const result = await controller.execute(
			{ type: "unknown", input: 'use "Existing"' },
			{ raw: 'use "Existing"', pi: h.pi, ctx: h.ctx, runtime: h.runtime },
		)

		expect(result).toEqual({ handled: true })
		expect(h.storage.list()).toHaveLength(0)
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unknown /ferment command"))
	})

	it("treats /ferment exit without an active ferment as a no-op", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()

		const result = await controller.execute({ type: "exit" }, { raw: "exit", pi: h.pi, ctx: h.ctx, runtime: h.runtime })

		expect(result).toEqual({ handled: true })
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("No active ferment to exit.")
		expect(h.storage.list()).toHaveLength(0)
		expect(h.runtime.setActive).not.toHaveBeenCalled()
		expect(h.pi.setActiveTools).not.toHaveBeenCalled()
		expect(requestSharedFooterRenderMock).not.toHaveBeenCalled()
		expect(h.ctx.abort).not.toHaveBeenCalled()
		expect(h.runtime.getContinuationPolicy()).toBe("manual")
	})

	it("/ferment exit preserves draft ferments and clears active mode", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ferment = h.storage.create("Draft Exit")
		h.runtime.setActive(ferment)
		vi.mocked(h.runtime.setActive).mockClear()

		const result = await controller.execute({ type: "exit" }, { raw: "exit", pi: h.pi, ctx: h.ctx, runtime: h.runtime })

		expect(result).toEqual({ handled: true })
		expect(h.storage.get(ferment.id)?.status).toBe("draft")
		expect(h.runtime.getActive()).toBeUndefined()
		expect(h.runtime.setActive).toHaveBeenLastCalledWith(undefined)
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"])
		expect(h.runtime.getContinuationPolicy()).toBe("manual")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Exited Ferment mode for "Draft Exit"'))
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_ack",
				display: true,
				content: [expect.objectContaining({ text: expect.stringContaining('Exited Ferment mode for "Draft Exit"') })],
			}),
			{ triggerTurn: false },
		)
		expect(requestSharedFooterRenderMock).toHaveBeenCalledTimes(1)
		expect(h.ctx.abort).toHaveBeenCalledTimes(1)
	})

	it("/ferment exit pauses planned ferments before clearing active mode", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ferment = createPlannedFerment(h, "Planned Exit")
		h.runtime.setContinuationPolicy("automated")
		h.runtime.setActive(ferment)
		vi.mocked(h.runtime.setActive).mockClear()

		const result = await controller.execute({ type: "exit" }, { raw: "exit", pi: h.pi, ctx: h.ctx, runtime: h.runtime })

		expect(result).toEqual({ handled: true })
		expect(h.storage.get(ferment.id)?.status).toBe("paused")
		expect(h.runtime.getActive()).toBeUndefined()
		expect(h.runtime.setActive).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }))
		expect(h.runtime.setActive).toHaveBeenLastCalledWith(undefined)
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"])
		expect(h.runtime.getContinuationPolicy()).toBe("automated")
	})

	it("/ferment exit pauses running ferments before clearing active mode", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ferment = createRunningFerment(h, "Running Exit")
		h.runtime.setActive(ferment)
		vi.mocked(h.runtime.setActive).mockClear()

		const result = await controller.execute({ type: "exit" }, { raw: "exit", pi: h.pi, ctx: h.ctx, runtime: h.runtime })

		expect(result).toEqual({ handled: true })
		expect(h.storage.get(ferment.id)?.status).toBe("paused")
		expect(h.runtime.getActive()).toBeUndefined()
		expect(h.runtime.setActive).toHaveBeenCalledWith(expect.objectContaining({ status: "paused" }))
		expect(h.runtime.setActive).toHaveBeenLastCalledWith(undefined)
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"])
	})

	it("/ferment exit leaves paused ferments paused while clearing active mode", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ferment = createPausedFerment(h, "Paused Exit")
		h.runtime.setActive(ferment)
		vi.mocked(h.runtime.setActive).mockClear()

		const result = await controller.execute({ type: "exit" }, { raw: "exit", pi: h.pi, ctx: h.ctx, runtime: h.runtime })

		expect(result).toEqual({ handled: true })
		expect(h.storage.get(ferment.id)?.status).toBe("paused")
		expect(h.runtime.getActive()).toBeUndefined()
		expect(h.runtime.setActive).toHaveBeenCalledTimes(1)
		expect(h.runtime.setActive).toHaveBeenLastCalledWith(undefined)
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"])
	})

	it("/ferment exit detaches terminal ferments without mutating lifecycle", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ferment = createCompleteFerment(h, "Complete Exit")
		h.runtime.setActive(ferment)
		vi.mocked(h.runtime.setActive).mockClear()

		const result = await controller.execute({ type: "exit" }, { raw: "exit", pi: h.pi, ctx: h.ctx, runtime: h.runtime })

		expect(result).toEqual({ handled: true })
		expect(h.storage.get(ferment.id)?.status).toBe("complete")
		expect(h.runtime.getActive()).toBeUndefined()
		expect(h.runtime.setActive).toHaveBeenCalledTimes(1)
		expect(h.runtime.setActive).toHaveBeenLastCalledWith(undefined)
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"])
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			'Exited Ferment mode for "Complete Exit". It remains complete and is still available from /ferment list.',
		)
	})

	it("/ferment exit clears only the exited ferment's pending review and scoping state", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const active = h.storage.create("Exit Pending State")
		const other = h.storage.create("Other Pending State")
		h.runtime.setActive(active)
		setPendingPlanReview({
			fermentId: active.id,
			planMarkdown: "# Plan: Exit Pending State",
		})
		setPendingPlanReview({
			fermentId: other.id,
			planMarkdown: "# Plan: Other Pending State",
		})
		h.runtime.setPendingScope(active.id, { goal: "Goal", successCriteria: ["Works"], constraints: [] })
		h.runtime.setPendingScope(other.id, { goal: "Other", successCriteria: ["Works"], constraints: [] })
		h.runtime.markScopingInteractive(active.id)
		h.runtime.markScopingConfirmed(active.id)
		h.runtime.markScopingInteractive(other.id)
		h.runtime.markScopingConfirmed(other.id)

		const result = await controller.execute({ type: "exit" }, { raw: "exit", pi: h.pi, ctx: h.ctx, runtime: h.runtime })

		expect(result).toEqual({ handled: true })
		expect(getPendingPlanReview(active.id)).toBeUndefined()
		expect(h.runtime.getPendingScope(active.id)).toBeUndefined()
		expect(h.runtime.isScopingInteractive(active.id)).toBe(false)
		expect(h.runtime.isScopingConfirmed(active.id)).toBe(false)
		expect(getPendingPlanReview(other.id)).toBeDefined()
		expect(h.runtime.getPendingScope(other.id)).toBeDefined()
		expect(h.runtime.isScopingInteractive(other.id)).toBe(true)
		expect(h.runtime.isScopingConfirmed(other.id)).toBe(true)
	})

	it("/ferment exit resets reactive nudges and prevents the exited ferment from continuing", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ferment = createPlannedFerment(h, "No Nudge After Exit")
		h.runtime.setContinuationPolicy("automated")
		h.runtime.setActive(ferment)
		maybeInjectReactiveContinuationNudge(h.pi, h.runtime)
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.objectContaining({ deliverAs: "followUp" }),
		)

		const result = await controller.execute({ type: "exit" }, { raw: "exit", pi: h.pi, ctx: h.ctx, runtime: h.runtime })
		vi.mocked(h.pi.sendMessage).mockClear()

		maybeInjectReactiveContinuationNudge(h.pi, h.runtime)

		expect(result).toEqual({ handled: true })
		expect(h.runtime.getActive()).toBeUndefined()
		expect(h.pi.sendMessage).not.toHaveBeenCalled()

		const resumed = createApplyAndPersist(h.runtime)(ferment.id, { type: "resume" })
		if (!resumed.ok) throw new Error(resumed.error.message)
		vi.mocked(h.pi.sendMessage).mockClear()

		maybeInjectReactiveContinuationNudge(h.pi, h.runtime)

		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.objectContaining({ deliverAs: "followUp" }),
		)
	})

	it("keeps headless one-shot without intent on the usage path", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()

		const result = await controller.execute(
			{ type: "one-shot", intent: "" },
			{ raw: "one-shot", pi: h.pi, ctx: h.ctx, runtime: h.runtime },
		)

		expect(result).toEqual({ handled: true })
		expect(h.ctx.ui.notify).toHaveBeenCalledWith('Usage: /ferment one-shot "description of what to build"')
		expect(h.storage.list()).toHaveLength(0)
		expect(h.pi.sendMessage).not.toHaveBeenCalled()
	})

	it("keeps UI one-shot without prompt handlers on the usage path", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ctx = {
			hasUI: true,
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext

		const result = await controller.execute(
			{ type: "one-shot", intent: "" },
			{ raw: "one-shot", pi: h.pi, ctx, runtime: h.runtime },
		)

		expect(result).toEqual({ handled: true })
		expect(ctx.ui.notify).toHaveBeenCalledWith('Usage: /ferment one-shot "description of what to build"')
		expect(h.storage.list()).toHaveLength(0)
		expect(h.pi.sendMessage).not.toHaveBeenCalled()
	})

	it("waits for headless one-shot turns before returning", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()

		const result = await controller.execute(
			{ type: "one-shot", intent: "fix the failing smoke test" },
			{ raw: 'one-shot "fix the failing smoke test"', pi: h.pi, ctx: h.ctx, runtime: h.runtime },
		)

		expect(result).toEqual({ handled: true })
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_oneshot_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("fix the failing smoke test") })],
			}),
			{ triggerTurn: true },
		)
		expect(h.ctx.waitForIdle).toHaveBeenCalledTimes(1)
	})

	it("uses the multi-line editor for free-form goal revisions", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const active = h.storage.create("Revise Goal")
		h.runtime.setActive(active)
		const ui = {
			notify: vi.fn(),
			editor: vi.fn().mockResolvedValueOnce("new goal\nwith detail"),
			input: vi.fn().mockResolvedValueOnce("single-line fallback"),
		}
		const ctx = {
			hasUI: true,
			ui,
		} as unknown as ExtensionCommandContext

		const result = await controller.execute(
			{ type: "revise", field: "goal" },
			{ raw: "revise goal", pi: h.pi, ctx, runtime: h.runtime },
		)

		expect(result).toEqual({ handled: true })
		expect(ui.editor).toHaveBeenCalledWith("Revise goal:", "")
		expect(ui.input).not.toHaveBeenCalled()
		expect(h.storage.get(active.id)?.goal).toBe("new goal\nwith detail")
		expect(ui.notify).toHaveBeenCalledWith('Goal updated: "new goal\nwith detail"')
	})

	it("reports export write failures without throwing", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const active = h.storage.create("Export Test")
		h.runtime.getActive = vi.fn(() => active)
		writeFileSyncMock.mockImplementation(() => {
			throw new Error("permission denied")
		})

		const result = await controller.execute(
			{ type: "export" },
			{ raw: "export", pi: h.pi, ctx: h.ctx, runtime: h.runtime },
		)

		expect(result).toEqual({ handled: true })
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Export failed: permission denied")
	})
})

describe("registerFermentCommands", () => {
	it("registers /ferment against the injected runtime storage", async () => {
		const h = createHarness()
		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler('new "Registered Command"', h.ctx)

		const created = h.storage.list().find((f) => f.name === "Registered Command")
		expect(created).toBeDefined()
		expect(h.runtime.setActive).toHaveBeenCalledWith(expect.objectContaining({ id: created?.id }))
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [expect.objectContaining({ text: expect.stringContaining("Scope:") })],
			}),
			{ triggerTurn: true },
		)
	})

	it("registers /ferment argument completions for lifecycle subcommands", async () => {
		const h = createHarness()
		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand?.getArgumentCompletions) throw new Error("ferment completions were not registered")

		const completions = await fermentCommand.getArgumentCompletions("pa")

		expect(completions).toContainEqual(
			expect.objectContaining({
				value: "pause",
				label: "pause",
				description: expect.stringContaining("Pause"),
			}),
		)
		expect(getFermentArgumentCompletions("man", h.runtime)).toContainEqual(
			expect.objectContaining({ value: "manual", label: "manual" }),
		)
		expect(getFermentArgumentCompletions("aut", h.runtime)).toContainEqual(
			expect.objectContaining({ value: "auto", label: "auto" }),
		)
		expect(getFermentArgumentCompletions("prog", h.runtime)).toContainEqual(
			expect.objectContaining({ value: "progress", label: "progress" }),
		)
		expect(getFermentArgumentCompletions("ex", h.runtime)).toContainEqual(
			expect.objectContaining({ value: "exit", label: "exit" }),
		)
		expect(completions).not.toContainEqual(expect.objectContaining({ value: "use " }))
		expect(completions).not.toContainEqual(expect.objectContaining({ value: "add " }))
	})

	it("advertises /ferment new as the create subcommand", () => {
		const h = createHarness()

		expect(getFermentArgumentCompletions("n", h.runtime)).toContainEqual(
			expect.objectContaining({ value: "new ", label: "new" }),
		)
	})

	it("shows /ferment new first in broad argument completions", () => {
		const h = createHarness()

		expect(getFermentArgumentCompletions("", h.runtime)?.[0]).toEqual(
			expect.objectContaining({ value: "new ", label: "new" }),
		)
	})

	it("completes /ferment target subcommands from stored ferments", () => {
		const h = createHarness()
		const ferment = h.storage.create("Auth Rewrite")

		const completions = getFermentArgumentCompletions("switch auth", h.runtime)

		expect(completions).toContainEqual(
			expect.objectContaining({
				value: `switch "${ferment.name}"`,
				label: ferment.name,
				description: expect.stringContaining(ferment.id.slice(0, 8)),
			}),
		)
		expect(getFermentArgumentCompletions("resume ", h.runtime)).toBeNull()
	})

	it("/ferment switch clears only the previous active pending plan review", async () => {
		const h = createHarness()
		const previous = h.storage.create("Previous Review")
		const target = h.storage.create("Target Review")
		h.runtime.setActive(previous)
		setPendingPlanReview({
			fermentId: previous.id,
			planMarkdown: "# Plan: Previous Review",
		})
		setPendingPlanReview({
			fermentId: target.id,
			planMarkdown: "# Plan: Target Review",
		})

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler(`switch "${target.name}"`, h.ctx)

		expect(getPendingPlanReview(previous.id)).toBeUndefined()
		expect(getPendingPlanReview(target.id)).toBeDefined()
	})

	it("completes /ferment nested static argument groups", () => {
		const h = createHarness()

		expect(getFermentArgumentCompletions("revise c", h.runtime)).toContainEqual(
			expect.objectContaining({ value: "revise criteria", label: "criteria" }),
		)
		expect(getFermentArgumentCompletions("mode e", h.runtime)).toBeNull()
	})

	it("does not register top-level ferment policy/progress shortcuts", () => {
		const h = createHarness()
		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		expect(commands.has("manual")).toBe(false)
		expect(commands.has("auto")).toBe(false)
		expect(commands.has("progress")).toBe(false)
	})

	it("/ferment manual and /ferment auto use the same continuation policy controls", async () => {
		const h = createHarness()
		const ferment = h.storage.create("Nested Policy Ferment")
		h.runtime.setActive(ferment)

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")

		await fermentCommand.handler("auto", h.ctx)
		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(h.storage.get(ferment.id)?.status).toBe("draft")

		await fermentCommand.handler("manual", h.ctx)
		expect(h.runtime.getContinuationPolicy()).toBe("manual")
		expect(h.storage.get(ferment.id)?.status).toBe("draft")
	})

	it("/ferment manual kicks a newly planned ferment into the first phase", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Planned Manual Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "First", goal: "Start", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		h.runtime.setActive(scoped.ferment)

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("manual", h.ctx)

		expect(h.runtime.getContinuationPolicy()).toBe("manual")
		expect(h.pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.anything(),
		)
	})

	it("/ferment manual still stops at a later phase boundary", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Manual Policy Boundary")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [
				{ name: "Done", goal: "Build", steps: [] },
				{ name: "Next", goal: "Continue", steps: [] },
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completed = applyAndPersist(activated.ferment.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completed.ok) throw new Error(completed.error.message)
		h.runtime.setActive(completed.ferment)

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("manual", h.ctx)

		expect(h.runtime.getContinuationPolicy()).toBe("manual")
		expect(h.pi.appendEntry).not.toHaveBeenCalled()
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_breadcrumb",
				details: expect.objectContaining({
					text: expect.stringContaining("Manual policy waiting at phase boundary"),
				}),
			}),
			expect.anything(),
		)
	})

	it("/ferment auto on a paused ferment sets automated policy without resuming lifecycle", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Paused Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const paused = applyAndPersist(ferment.id, { type: "pause" })
		if (!paused.ok) throw new Error(paused.error.message)

		let active = paused.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setActive = vi.fn((ferment) => {
			active = ferment ?? active
		})

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("auto", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(active.status).toBe("paused")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("run /ferment resume"))
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "propose_ferment_scoping"])
		expect(h.pi.sendMessage).not.toHaveBeenCalled()
	})

	it("/ferment mode is no longer a command", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ferment = h.storage.create("Legacy Mode Command")
		h.runtime.setActive(ferment)

		const result = await controller.execute(
			{ type: "unknown", input: "mode exec" },
			{ raw: "mode exec", pi: h.pi, ctx: h.ctx, runtime: h.runtime },
		)

		expect(result).toEqual({ handled: true })
		expect(h.runtime.getContinuationPolicy()).toBe("manual")
		expect(h.storage.get(ferment.id)).not.toHaveProperty("mode")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unknown /ferment command"))
		expect(h.pi.sendMessage).not.toHaveBeenCalled()
	})

	it("/ferment progress renders the headless status", async () => {
		const h = createHarness()
		const ferment = h.storage.create("Progress Ferment")
		h.runtime.setActive(ferment)

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		expect(commands.has("progress")).toBe(false)

		await fermentCommand.handler("progress", h.ctx)

		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Progress Ferment"))
	})

	it("/ferment auto at a phase boundary only changes continuation policy", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Boundary Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [
				{ name: "Done", goal: "Build", steps: [] },
				{ name: "Next", goal: "Continue", steps: [] },
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completed = applyAndPersist(ferment.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completed.ok) throw new Error(completed.error.message)

		let active = completed.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setActive = vi.fn((ferment) => {
			active = ferment ?? active
		})

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("auto", h.ctx)

		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(active.status).toBe("planned")
		expect(active.phases[1].status).toBe("planned")
		expect(h.pi.sendMessage).not.toHaveBeenCalled()
	})

	it("/ferment list Continue on the active ferment kicks continuation", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Active List Continue")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)

		let active = activated.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.getActiveId = vi.fn(() => active?.id)
		h.runtime.setActive = vi.fn((ferment) => {
			active = ferment
		})
		const select = vi
			.fn()
			.mockImplementationOnce((_title: string, options: string[]) => options[0])
			.mockImplementationOnce((_title: string, options: string[]) => options[0])
		const ctx = { ...h.ctx, hasUI: true, ui: { ...h.ctx.ui, select } } as ExtensionCommandContext

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("list", ctx)

		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("start_ferment_step") })],
				details: expect.objectContaining({ action: "wake_up", expectedAction: "start_step" }),
			}),
			{ triggerTurn: true },
		)
		expect(ctx.ui.notify).toHaveBeenCalledWith('Continuing "Active List Continue"')
	})

	it("/ferment list Continue explicitly crosses a manual phase boundary", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Boundary List Continue")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [
				{ name: "Done", goal: "Build", steps: [] },
				{ name: "Next", goal: "Continue", steps: [] },
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completed = applyAndPersist(activated.ferment.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completed.ok) throw new Error(completed.error.message)

		let active = completed.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.getActiveId = vi.fn(() => active?.id)
		h.runtime.setActive = vi.fn((ferment) => {
			active = ferment
		})
		h.runtime.setContinuationPolicy("manual")
		const select = vi
			.fn()
			.mockImplementationOnce((_title: string, options: string[]) => options[0])
			.mockImplementationOnce((_title: string, options: string[]) => options[0])
		const ctx = { ...h.ctx, hasUI: true, ui: { ...h.ctx.ui, select } } as ExtensionCommandContext

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("list", ctx)

		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("activate_ferment_phase") })],
				details: expect.objectContaining({ action: "wake_up", expectedAction: "activate_phase" }),
			}),
			{ triggerTurn: true },
		)
		expect(active.status).toBe("planned")
		expect(ctx.ui.notify).toHaveBeenCalledWith('Continuing "Boundary List Continue"')
	})

	it("does not register a top-level /pause command", () => {
		const h = createHarness()
		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI

		registerFermentCommands(pi, h.runtime)

		expect(commands.has("pause")).toBe(false)
	})

	it("/ferment pause transitions running ferment to paused status", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Running Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)

		let active = activated.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setContinuationPolicy("automated")

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("pause", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(active.status).toBe("paused")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Paused"))
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(
			expect.arrayContaining([
				"read",
				"bash",
				"Agent",
				"edit",
				"write",
				"start_ferment_step",
				"activate_ferment_phase",
				"complete_ferment_step",
				"verify_ferment_step",
				"complete_ferment",
			]),
		)
		expect(h.ctx.abort).toHaveBeenCalled()
	})

	it("/ferment pause is a no-op when already paused", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Already Paused Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const paused = applyAndPersist(ferment.id, { type: "pause" })
		if (!paused.ok) throw new Error(paused.error.message)

		let active = paused.ferment
		h.runtime.getActive = vi.fn(() => active)

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("pause", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(active.status).toBe("paused")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already paused"))
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/ferment resume"))
		expect(h.ctx.abort).not.toHaveBeenCalled()
	})

	it("implements pause → /ferment auto → /ferment resume with policy separated from lifecycle", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Lifecycle Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }, { description: "Test it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)

		let active = activated.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setActive = vi.fn((f) => {
			active = f ?? active
		})
		h.runtime.setContinuationPolicy("manual")
		h.pi.setActiveTools = vi.fn()

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		// Step 1: Verify initial state (running with active phase)
		expect(active.status).toBe("running")
		expect(active.phases[0].status).toBe("active")

		// Step 2: Call /ferment pause → status becomes "paused", steps reset to "pending"
		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("pause", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("manual")
		expect(active.status).toBe("paused")
		expect(active.phases[0].steps[0].status).toBe("pending")
		expect(active.phases[0].steps[1].status).toBe("pending")
		expect(h.ctx.abort).toHaveBeenCalled()

		// Step 3: Call /ferment auto → policy changes, lifecycle stays paused
		await fermentCommand.handler("auto", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(active.status).toBe("paused")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("run /ferment resume"))

		// Step 4: Call /ferment resume → lifecycle resumes using the current policy
		await fermentCommand.handler("resume", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(active.status).toBe("running")
		expect(active.phases[0].status).toBe("active")
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(
			expect.arrayContaining(["read", "bash", "start_ferment_step", "activate_ferment_phase", "complete_ferment_step"]),
		)
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("start_ferment_step") })],
				details: expect.objectContaining({ action: "wake_up", expectedAction: "start_step" }),
			}),
			{ triggerTurn: true },
		)
	})

	it("/ferment resume in manual policy kicks work inside the active phase", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Manual Resume Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const paused = applyAndPersist(activated.ferment.id, { type: "pause" })
		if (!paused.ok) throw new Error(paused.error.message)

		let active = paused.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setActive = vi.fn((f) => {
			active = f ?? active
		})
		h.runtime.setContinuationPolicy("manual")

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("resume", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("manual")
		expect(active.status).toBe("running")
		expect(active.phases[0].status).toBe("active")
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("start_ferment_step") })],
				details: expect.objectContaining({ action: "wake_up", expectedAction: "start_step" }),
			}),
			{ triggerTurn: true },
		)
	})

	it("/ferment resume in manual policy does not cross a phase boundary", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Manual Boundary Resume")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [
				{ name: "Done", goal: "Build", steps: [] },
				{ name: "Next", goal: "Continue", steps: [] },
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completed = applyAndPersist(activated.ferment.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completed.ok) throw new Error(completed.error.message)
		const paused = applyAndPersist(completed.ferment.id, { type: "pause" })
		if (!paused.ok) throw new Error(paused.error.message)

		let active = paused.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setActive = vi.fn((f) => {
			active = f ?? active
		})
		h.runtime.setContinuationPolicy("manual")

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("resume", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(active.status).toBe("planned")
		expect(active.phases[1].status).toBe("planned")
		expect(h.pi.appendEntry).not.toHaveBeenCalled()
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_breadcrumb",
				details: expect.objectContaining({
					text: expect.stringContaining("Manual policy waiting at phase boundary"),
				}),
			}),
			expect.anything(),
		)
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('is waiting before "Next". Choose Continue'))
	})

	it("/ferment resume in manual policy asks before crossing a phase boundary", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Manual Boundary Prompt")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [
				{ name: "Done", goal: "Build", steps: [] },
				{ name: "Next", goal: "Continue", steps: [] },
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completed = applyAndPersist(activated.ferment.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completed.ok) throw new Error(completed.error.message)
		const paused = applyAndPersist(completed.ferment.id, { type: "pause" })
		if (!paused.ok) throw new Error(paused.error.message)

		let active = paused.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setActive = vi.fn((f) => {
			active = f ?? active
		})
		h.runtime.setContinuationPolicy("manual")
		const select = vi.fn(async () => "Continue to next phase")
		const ctx = { ...h.ctx, hasUI: true, ui: { ...h.ctx.ui, select } } as ExtensionCommandContext

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("resume", ctx)

		active = h.storage.get(active.id) ?? active
		expect(active.status).toBe("planned")
		expect(active.phases[1].status).toBe("planned")
		expect(select).toHaveBeenCalledWith(expect.stringContaining('Continue "Manual Boundary Prompt" to "Next"?'), [
			"Continue to next phase",
			"Pause here",
		])
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("activate_ferment_phase") })],
				details: expect.objectContaining({ action: "wake_up", expectedAction: "activate_phase" }),
			}),
			{ triggerTurn: true },
		)
	})
})
