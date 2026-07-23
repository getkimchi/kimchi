import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { COUNCIL_PROGRESS_WIDGET_KEY, CouncilProgressUI } from "./progress-ui.js"
import type { CouncilProgressEvent } from "./types.js"

type WidgetFactory = (
	tui: { requestRender(): void },
	theme: { bold(text: string): string; fg(color: string, text: string): string },
) => { render(width: number): string[] }

function createHarness() {
	const setStatus = vi.fn()
	const setWidget = vi.fn()
	const controller = new CouncilProgressUI({ setStatus, setWidget } as never)
	const tui = { requestRender: vi.fn() }
	const theme = {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
	}
	const render = (): string => {
		const call = [...setWidget.mock.calls].reverse().find((candidate) => typeof candidate[1] === "function")
		const factory = call?.[1] as WidgetFactory | undefined
		if (!factory) throw new Error("Council progress widget was not mounted")
		return factory(tui, theme).render(120).join("\n")
	}
	return { controller, render, setStatus, setWidget, tui }
}

function start(runId: string, startedAt: number, preset: "fast" | "normal" | "deep" = "normal") {
	return { type: "run_started", runId, preset, startedAt } as const
}

describe("CouncilProgressUI", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it("renders only configured logical roles and never exposes run, stage, retry, or error details", () => {
		const { controller, render } = createHarness()
		controller.handle(start("private-run-model", 10))
		controller.handle({
			type: "stage_started",
			runId: "private-run-model",
			stageId: "physical/model retry-1 <think>secret</think>",
			role: "critic",
			startedAt: 11,
		})
		controller.handle({
			type: "stage_started",
			runId: "private-run-model",
			stageId: "physical/fallback retry-2",
			role: "critic",
			startedAt: 12,
		})
		controller.handle({
			type: "stage_failed",
			runId: "private-run-model",
			stageId: "physical/model retry-1",
			role: "critic",
			durationMs: 900,
			reason: "review_unavailable",
			error: "raw provider exception",
		} as CouncilProgressEvent)

		const output = render()
		expect(output).toMatch(/^⠋ Council · reviewing 1\/3/)
		expect(output).toContain("independent")
		expect(output).toContain("├─ ⚠ critic · review unavailable")
		expect(output).not.toContain("adjudicating")
		expect(output).toContain("checker")
		expect(output.match(/critic/g)).toHaveLength(1)
		expect(output).not.toMatch(/private-run|physical\/|retry-|<think>|secret|raw provider exception/)
	})

	it("omits judge and unconfigured reviewers for the fast preset", () => {
		const { controller, render } = createHarness()
		controller.handle(start("fast", 10, "fast"))

		const output = render()
		expect(output).toContain("Council · drafting")
		expect(output).toContain("critic")
		expect(output).not.toContain("independent")
		expect(output).not.toContain("checker")
		expect(output).not.toContain("adjudicating")
	})

	it("shows fixed labels for drafting, adjudication, repair, and revision", () => {
		const { controller, render } = createHarness()
		controller.handle(start("roles", 10))
		controller.handle({ type: "stage_started", runId: "roles", stageId: "lead", role: "lead", startedAt: 11 })
		expect(render()).toContain("Council · drafting")
		controller.handle({ type: "stage_completed", runId: "roles", stageId: "lead", role: "lead", durationMs: 1 })
		controller.handle({ type: "stage_started", runId: "roles", stageId: "judge", role: "judge", startedAt: 12 })
		expect(render()).toContain("Council · adjudicating")
		controller.handle({ type: "stage_completed", runId: "roles", stageId: "judge", role: "judge", durationMs: 1 })
		controller.handle({ type: "stage_started", runId: "roles", stageId: "repair", role: "repair", startedAt: 13 })
		expect(render()).toContain("Council · validating review")
		controller.handle({ type: "stage_completed", runId: "roles", stageId: "repair", role: "repair", durationMs: 1 })
		controller.handle({ type: "stage_started", runId: "roles", stageId: "revision", role: "revision", startedAt: 14 })
		expect(render()).toContain("Council · revising")
	})

	it.each([
		["preparing_candidate", "preparing candidate"],
		["validating_patch", "validating patch"],
		["reviewing", "reviewing"],
		["adjudicating", "adjudicating"],
		["revising", "revising"],
		["applying", "applying"],
	] as const)("shows the safe transaction phase %s", (phase, label) => {
		const { controller, render } = createHarness()
		controller.handle(start(`phase-${phase}`, 10))
		controller.handle({ type: "transaction_progress", runId: `phase-${phase}`, phase })

		expect(render()).toContain(`Council · ${label}`)
	})

	it("replaces live progress with a static summary containing only provided positive cost and agreement", () => {
		const { controller, setStatus, setWidget } = createHarness()
		controller.handle(start("first", 10))
		controller.handle({
			type: "run_completed",
			runId: "first",
			outcome: "accepted",
			durationMs: 1234,
			estimatedCostUsd: 0,
		})

		expect(setWidget).toHaveBeenNthCalledWith(2, COUNCIL_PROGRESS_WIDGET_KEY, undefined, {
			placement: "aboveEditor",
		})
		expect(setWidget).toHaveBeenLastCalledWith(COUNCIL_PROGRESS_WIDGET_KEY, ["✓ Council · accepted · 1.2s"], {
			placement: "aboveEditor",
		})
		expect(setStatus).toHaveBeenLastCalledWith("council", "✓ Council · accepted · 1.2s")
		expect(vi.getTimerCount()).toBe(0)

		controller.handle(start("second", 20))
		controller.handle({
			type: "run_completed",
			runId: "second",
			outcome: "tool_use",
			durationMs: 2000,
			agreement: "low",
			estimatedCostUsd: 0.0042,
		})
		expect(setStatus).toHaveBeenLastCalledWith("council", "✓ Council · tool requested · low agreement · 2.0s · $0.0042")
		expect(setWidget).toHaveBeenLastCalledWith(
			COUNCIL_PROGRESS_WIDGET_KEY,
			["✓ Council · tool requested · low agreement · 2.0s · $0.0042"],
			{ placement: "aboveEditor" },
		)

		controller.handle(start("third", 30))
		controller.handle({
			type: "run_completed",
			runId: "third",
			outcome: "revised",
			durationMs: 100,
			estimatedCostUsd: 1.2,
		})
		expect(setStatus).toHaveBeenLastCalledWith("council", "✓ Council · revised · 0.1s · $1.20")

		controller.handle(start("fourth", 40))
		controller.handle({ type: "run_completed", runId: "fourth", outcome: "degraded", durationMs: 300 })
		expect(setStatus).toHaveBeenLastCalledWith("council", "⚠ Council · degraded · 0.3s")
	})

	it("ignores old run starts and late events after a newer run", () => {
		const { controller, render, setStatus, setWidget } = createHarness()
		controller.handle(start("old", 10, "deep"))
		controller.handle(start("new", 10, "fast"))
		const mountCalls = setWidget.mock.calls.filter((call) => typeof call[1] === "function").length

		controller.handle(start("old", 10, "deep"))
		controller.handle(start("unseen-but-older", 9, "deep"))
		controller.handle({ type: "stage_started", runId: "old", stageId: "old:judge", role: "judge", startedAt: 21 })
		controller.handle({ type: "run_completed", runId: "old", outcome: "accepted", durationMs: 1 })
		expect(setWidget.mock.calls.filter((call) => typeof call[1] === "function")).toHaveLength(mountCalls)
		expect(render()).not.toContain("adjudicating")
		expect(setStatus).not.toHaveBeenCalled()

		controller.handle({ type: "run_completed", runId: "new", outcome: "accepted", durationMs: 1 })
		const callsAfterTerminal = setWidget.mock.calls.length
		controller.handle(start("new", 10, "deep"))
		controller.handle({ type: "stage_started", runId: "new", stageId: "new:judge", role: "judge", startedAt: 22 })
		expect(setWidget).toHaveBeenCalledTimes(callsAfterTerminal)
		expect(setStatus).toHaveBeenCalledTimes(1)
	})

	it("animates while live and clears widget, timer, and summary", () => {
		const { controller, render, setStatus, setWidget, tui } = createHarness()
		controller.handle(start("run", 10))
		render()
		vi.advanceTimersByTime(80)
		expect(tui.requestRender).toHaveBeenCalled()

		controller.handle({ type: "run_failed", runId: "run", durationMs: 500, reason: "limit_reached" })
		expect(setStatus).toHaveBeenLastCalledWith(
			"council",
			"✗ Council · could not safely finalize · limit reached · 0.5s",
		)
		expect(vi.getTimerCount()).toBe(0)

		controller.clear()
		expect(setStatus).toHaveBeenLastCalledWith("council", undefined)
		expect(setWidget).toHaveBeenCalledWith(COUNCIL_PROGRESS_WIDGET_KEY, undefined, { placement: "aboveEditor" })
	})

	it("keeps concurrent sessions isolated when one aborts and the other shuts down", () => {
		const first = createHarness()
		const second = createHarness()
		first.controller.handle(start("first", 10))
		second.controller.handle(start("second", 20))
		expect(vi.getTimerCount()).toBe(2)

		first.controller.handle({ type: "run_aborted", runId: "first", durationMs: 250, reason: "cancelled" })
		expect(first.setWidget).toHaveBeenLastCalledWith(COUNCIL_PROGRESS_WIDGET_KEY, ["⚠ Council · cancelled · 0.3s"], {
			placement: "aboveEditor",
		})
		expect(first.setStatus).toHaveBeenLastCalledWith("council", "⚠ Council · cancelled · 0.3s")
		expect(second.render()).toContain("Council · drafting")
		expect(second.setStatus).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(1)

		second.controller.dispose()
		expect(second.setWidget).toHaveBeenLastCalledWith(COUNCIL_PROGRESS_WIDGET_KEY, undefined, {
			placement: "aboveEditor",
		})
		expect(vi.getTimerCount()).toBe(0)
	})

	it("never remounts from late events after disposal", () => {
		const { controller, setStatus, setWidget } = createHarness()
		controller.handle(start("active", 10))
		controller.dispose()
		const widgetCalls = setWidget.mock.calls.length
		const statusCalls = setStatus.mock.calls.length

		controller.handle(start("late", 20))
		controller.handle({ type: "run_completed", runId: "late", outcome: "accepted", durationMs: 1 })

		expect(setWidget).toHaveBeenCalledTimes(widgetCalls)
		expect(setStatus).toHaveBeenCalledTimes(statusCalls)
		expect(vi.getTimerCount()).toBe(0)
	})
})
