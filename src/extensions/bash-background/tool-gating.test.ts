/**
 * Unit tests for `createToolGating` — the visibility-gating state machine
 * that hides every active tool except `bash_control` while a background
 * bash process awaits a control decision, then restores them.
 */
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createToolGating } from "./tool-gating.js"

type ShutdownHandler = () => void

function makePi(toolNames: string[]): ExtensionAPI & { active: string[]; fireShutdown: () => void } {
	const tools = toolNames.map((name) => ({ name }) as ToolInfo)
	const shutdownHandlers: ShutdownHandler[] = []
	const state = {
		active: [...toolNames],
		fireShutdown: () => {
			for (const h of shutdownHandlers) h()
		},
		getAllTools: () => tools,
		getActiveTools() {
			return state.active
		},
		setActiveTools(names: string[]) {
			state.active = names
		},
		on(event: string, handler: ShutdownHandler) {
			if (event === "session_shutdown") shutdownHandlers.push(handler)
		},
	}
	return state as unknown as ExtensionAPI & { active: string[]; fireShutdown: () => void }
}

describe("createToolGating", () => {
	it("suppressOthers hides every active tool except bash_control", () => {
		const pi = makePi(["bash", "read", "edit", "write", "bash_control"])
		const gating = createToolGating(pi)

		gating.suppressOthers()

		expect(pi.active).toEqual(["bash_control"])
		expect(gating.isSuppressed).toBe(true)
	})

	it("restore re-enables exactly the tools that were hidden", () => {
		const pi = makePi(["bash", "read", "edit", "bash_control"])
		const gating = createToolGating(pi)

		gating.suppressOthers()
		expect(pi.active).toEqual(["bash_control"])

		gating.restore()
		expect(pi.active.sort()).toEqual(["bash", "bash_control", "edit", "read"])
		expect(gating.isSuppressed).toBe(false)
	})

	it("suppressOthers is idempotent — a second call is a no-op", () => {
		const pi = makePi(["bash", "read", "bash_control"])
		const gating = createToolGating(pi)

		gating.suppressOthers()
		const afterFirst = [...pi.active]
		gating.suppressOthers()
		expect(pi.active).toEqual(afterFirst)
		expect(gating.isSuppressed).toBe(true)
	})

	it("restore is idempotent — a second call is a no-op", () => {
		const pi = makePi(["bash", "bash_control"])
		const gating = createToolGating(pi)

		gating.restore() // no-op when not suppressed
		expect(gating.isSuppressed).toBe(false)

		gating.suppressOthers()
		gating.restore()
		const afterRestore = [...pi.active]
		gating.restore()
		expect(pi.active).toEqual(afterRestore)
	})

	it("suppressOthers when bash_control is already the only tool is a clean no-op", () => {
		const pi = makePi(["bash_control"])
		const gating = createToolGating(pi)

		gating.suppressOthers()
		expect(pi.active).toEqual(["bash_control"])
		expect(gating.isSuppressed).toBe(true)

		gating.restore()
		expect(pi.active).toEqual(["bash_control"])
	})

	it("repeated suppress/restore cycles work correctly", () => {
		const pi = makePi(["bash", "read", "bash_control"])
		const gating = createToolGating(pi)

		// First cycle.
		gating.suppressOthers()
		expect(pi.active).toEqual(["bash_control"])
		gating.restore()
		expect(pi.active.sort()).toEqual(["bash", "bash_control", "read"])

		// Second cycle — must hide the same set again.
		gating.suppressOthers()
		expect(pi.active).toEqual(["bash_control"])
		gating.restore()
		expect(pi.active.sort()).toEqual(["bash", "bash_control", "read"])
	})

	it("does not clobber another extension's disable vote", () => {
		// Simulate another extension having already disabled 'edit' via the
		// shared visibility layer. The gating's suppressOthers must not
		// re-surface 'edit' on restore.
		const pi = makePi(["bash", "read", "bash_control"])
		const otherExt = createToolVisibilityPublic(pi)
		otherExt.disable(["edit"])
		// 'edit' was not in the active list to begin with, so it stays absent.
		expect(pi.active).toEqual(["bash", "read", "bash_control"])

		const gating = createToolGating(pi)
		gating.suppressOthers()
		expect(pi.active).toEqual(["bash_control"])

		gating.restore()
		// restore brings back bash + read, but NOT edit (other extension's vote stands).
		expect(pi.active.sort()).toEqual(["bash", "bash_control", "read"])
		expect(pi.active).not.toContain("edit")
	})
})

// Local re-export to test cross-extension vote composition without importing
// the full visibility module surface.
import { createToolVisibility as createToolVisibilityPublic } from "../prompt-construction/tool-visibility.js"
