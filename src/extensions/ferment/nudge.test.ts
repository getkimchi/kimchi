import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import { maybeInjectAutoNudge, onStepCompleted } from "./nudge.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { getActive, setActive } from "./state.js"
import { createApplyAndPersist } from "./tool-helpers.js"

function createPi(): ExtensionAPI {
	return {
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI
}

function makeDraftFerment(overrides: Partial<Ferment> = {}): Ferment {
	const now = "2026-01-01T00:00:00.000Z"
	return {
		id: "ferment-1",
		name: "Injected Nudge",
		status: "draft",
		mode: "plan",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	}
}

afterEach(() => {
	setActive(undefined)
})

describe("ferment nudges", () => {
	it("reads active and auto-mode state from the injected runtime", () => {
		const pi = createPi()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: () => makeDraftFerment(),
			isAutoModeEnabled: () => true,
		}

		maybeInjectAutoNudge(pi, { force: true }, runtime)

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"ferment_breadcrumb",
			expect.objectContaining({ text: expect.stringContaining('Resume [scope]: "Injected Nudge"') }),
		)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_automode_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("RESUMING ferment after /auto") })],
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		)
	})

	it("syncs active state from injected storage on step completion", () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-nudge-test-")))
		const setActiveSpy = vi.fn()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			getActiveId: () => "ferment-1",
			setActive: setActiveSpy,
			isAutoModeEnabled: () => false,
		}
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Injected Store")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		runtime.getActiveId = () => scoped.ferment.id

		onStepCompleted(createPi(), runtime)

		expect(setActiveSpy).toHaveBeenCalledWith(expect.objectContaining({ id: scoped.ferment.id }))
		expect(getActive()).toBeUndefined()
	})
})
