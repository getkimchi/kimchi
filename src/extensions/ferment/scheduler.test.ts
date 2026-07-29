import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import { createDefaultFermentRuntime, type FermentRuntime } from "./runtime.js"
import { scheduleFermentWakeUp, scheduleNextFermentAction } from "./scheduler.js"
import { setActive } from "./state.js"
import { createApplyAndPersist } from "./tool-helpers.js"

function createPi(): ExtensionAPI {
	return {
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI
}

const tmpDirs: string[] = []

/**
 * Builds a runtime backed by a real FermentEventStore with a freshly created
 * draft ferment (no phases). `determineNextAction` resolves such a draft to a
 * `{ kind: "scope" }` action, which is the exact path that regresses.
 */
function makeRuntime(policy: "automated" | "manual"): {
	runtime: FermentRuntime
	draftId: string
} {
	const tmpDir = mkdtempSync(join(tmpdir(), "ferment-scheduler-test-"))
	tmpDirs.push(tmpDir)
	const storage = new FermentEventStore(tmpDir)
	const draft = storage.create("Scheduler Nudge Draft")
	const runtime: FermentRuntime = {
		...createDefaultFermentRuntime(),
		getStorage: () => storage,
		getActiveId: () => draft.id,
		getContinuationPolicy: () => policy,
		isAutomatedContinuationEnabled: () => policy === "automated",
	}
	return { runtime, draftId: draft.id }
}

/**
 * Builds a runtime backed by a real FermentEventStore with a scoped ferment in
 * the "planned" status (phases defined, none active). `determineNextAction`
 * resolves such a ferment to an `activate_phase` action, exercising the
 * contextual-nudge path used by `scheduleFermentWakeUp`.
 */
function makePlannedRuntime(policy: "automated" | "manual"): {
	runtime: FermentRuntime
	fermentId: string
} {
	const tmpDir = mkdtempSync(join(tmpdir(), "ferment-scheduler-test-"))
	tmpDirs.push(tmpDir)
	const storage = new FermentEventStore(tmpDir)
	const draft = storage.create("Planned Nudge Ferment")
	const runtime: FermentRuntime = {
		...createDefaultFermentRuntime(),
		getStorage: () => storage,
		getActiveId: () => draft.id,
		getContinuationPolicy: () => policy,
		isAutomatedContinuationEnabled: () => policy === "automated",
	}
	const applyAndPersist = createApplyAndPersist(runtime)
	const scoped = applyAndPersist(draft.id, {
		type: "scope",
		title: "Planned Nudge Ferment",
		goal: "g",
		successCriteria: ["c"],
		constraints: [],
		assumptions: "a",
		phases: [{ name: "P1", goal: "g", steps: [{ description: "s1" }] }],
	})
	if (!scoped.ok) throw new Error(scoped.error.message)
	return { runtime, fermentId: scoped.ferment.id }
}

afterEach(() => {
	setActive(undefined)
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe("scheduleNextFermentAction — scope nudge suppression", () => {
	it("sends a ferment_continuation_nudge for a draft scope action under automated policy", () => {
		const pi = createPi()
		const { runtime, draftId } = makeRuntime("automated")
		const draft = runtime.getStorage().get(draftId)
		if (!draft) throw new Error("draft not found")
		// sanity: a fresh draft with no phases resolves to a scope action
		expect(draft.phases).toHaveLength(0)
		expect(draft.status).toBe("draft")

		scheduleNextFermentAction(pi, draft, runtime)

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				content: [expect.objectContaining({ type: "text" })],
				details: { action: "scope" },
			}),
			expect.objectContaining({ triggerTurn: true }),
		)
	})

	it("suppresses the scope nudge under manual policy (PR #289 interactive behaviour preserved)", () => {
		const pi = createPi()
		const { runtime, draftId } = makeRuntime("manual")
		const draft = runtime.getStorage().get(draftId)
		if (!draft) throw new Error("draft not found")

		scheduleNextFermentAction(pi, draft, runtime)

		expect(pi.sendMessage).not.toHaveBeenCalled()
	})
})

describe("scheduleFermentWakeUp — messagePrefix composition", () => {
	it("prepends messagePrefix to the contextual scheduler message", () => {
		const pi = createPi()
		const { runtime, fermentId } = makePlannedRuntime("automated")

		const prefix = 'RESUMING ferment "Planned" — pick up the work immediately.'
		scheduleFermentWakeUp(pi, runtime, { fermentId, tag: "Resume wake-up", messagePrefix: prefix })

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_continuation_nudge",
				display: false,
			}),
			expect.objectContaining({ triggerTurn: true }),
		)

		const call = vi.mocked(pi.sendMessage).mock.calls[0][0]
		const raw = call.content
		const text = typeof raw === "string" ? raw : (raw ?? []).map((p) => ("text" in p ? p.text : "")).join("")
		// The prefix must appear before the contextual nudge body.
		expect(text.startsWith(prefix)).toBe(true)
		// The contextual nudge (activate_ferment_phase) must follow the prefix.
		expect(text).toContain("activate_ferment_phase")
	})

	it("sends the contextual nudge unchanged when messagePrefix is omitted", () => {
		const pi = createPi()
		const { runtime, fermentId } = makePlannedRuntime("automated")

		scheduleFermentWakeUp(pi, runtime, { fermentId, tag: "Wake-up" })

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const call = vi.mocked(pi.sendMessage).mock.calls[0][0]
		const raw = call.content
		const text = typeof raw === "string" ? raw : (raw ?? []).map((p) => ("text" in p ? p.text : "")).join("")
		expect(text).toContain("activate_ferment_phase")
	})

	it("omits the scheduler breadcrumb when requested", () => {
		const pi = createPi()
		const { runtime, fermentId } = makePlannedRuntime("automated")

		scheduleFermentWakeUp(pi, runtime, { fermentId, skipBreadcrumb: true })

		expect(pi.appendEntry).not.toHaveBeenCalled()
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "ferment_continuation_nudge" }), {
			triggerTurn: true,
		})
	})
})
