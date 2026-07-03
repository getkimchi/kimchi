import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { scheduleNextFermentAction } from "./scheduler.js"
import { setActive } from "./state.js"

function createPi(): ExtensionAPI {
	return {
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI
}

/**
 * Builds a runtime backed by a real FermentEventStore with a freshly created
 * draft ferment (no phases). `determineNextAction` resolves such a draft to a
 * `{ kind: "scope" }` action, which is the exact path that regresses.
 */
const tmpDirs: string[] = []

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
