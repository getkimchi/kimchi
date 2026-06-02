import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTeleportProgress } from "./progress.js"

interface CustomCall {
	factory: (
		tui: { requestRender: ReturnType<typeof vi.fn>; terminal: { rows: number; cols: number } },
		theme: Theme,
		kb: unknown,
		done: ReturnType<typeof vi.fn>,
	) => Component & { dispose?(): void }
	options: { overlay?: boolean; overlayOptions?: unknown }
	done: ReturnType<typeof vi.fn>
	tui: { requestRender: ReturnType<typeof vi.fn>; terminal: { rows: number; cols: number } }
	theme: Theme
	component?: Component & { dispose?(): void }
}

type DeferredMount = "immediate" | "manual"

function makeTheme(): Theme {
	return {
		fg: (_color: unknown, text: string) => text,
		bg: (_color: unknown, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme
}

function makeUi(mount: DeferredMount = "immediate"): {
	ui: ExtensionUIContext
	customCalls: CustomCall[]
	mountPending(): void
} {
	const customCalls: CustomCall[] = []
	const pendingMounts: Array<() => void> = []
	const custom = vi.fn((factory: CustomCall["factory"], options: CustomCall["options"]) => {
		const tui = { requestRender: vi.fn(), terminal: { rows: 30, cols: 80 } }
		const theme = makeTheme()
		const done = vi.fn()
		const call: CustomCall = { factory, options, done, tui, theme }
		customCalls.push(call)
		const mountFn = () => {
			call.component = factory(tui, theme, {}, done)
		}
		if (mount === "immediate") mountFn()
		else pendingMounts.push(mountFn)
		return Promise.resolve(undefined as unknown)
	})
	const ui = { custom } as unknown as ExtensionUIContext
	return {
		ui,
		customCalls,
		mountPending() {
			for (const fn of pendingMounts.splice(0)) fn()
		},
	}
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("createTeleportProgress", () => {
	it("opens a centered 80% overlay via ui.custom on construction", () => {
		const h = makeUi()
		createTeleportProgress(h.ui)
		expect(h.customCalls).toHaveLength(1)
		expect(h.customCalls[0].options).toEqual({
			overlay: true,
			overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" },
		})
	})

	it("step + complete updates the panel and the rendered body contains the completed label", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		progress.step("Authenticating")
		progress.complete("Authenticated")
		const lines = h.customCalls[0].component?.render(80) ?? []
		const joined = lines.join("\n")
		expect(joined).toContain("Authenticated")
		expect(joined).toContain("✓")
	})

	it("finish calls done exactly once", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		progress.finish({ id: "ws1", url: "wss://x", description: "test" })
		expect(h.customCalls[0].done).toHaveBeenCalledTimes(1)
		expect(h.customCalls[0].done).toHaveBeenCalledWith(undefined)
	})

	it("stop after finish is a no-op (done called only once)", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		progress.finish({ id: "ws1", url: "wss://x", description: "test" })
		progress.stop()
		expect(h.customCalls[0].done).toHaveBeenCalledTimes(1)
	})

	it("stop closes the overlay", () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		progress.stop()
		expect(h.customCalls[0].done).toHaveBeenCalledTimes(1)
	})

	it("promptGitToken switches the panel to git-token mode and renders the host", async () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		const promise = progress.promptGitToken("github.com")
		// Render after entering git-token mode.
		const joined = (h.customCalls[0].component?.render(80) ?? []).join("\n")
		expect(joined).toContain("github.com")
		// Don't leak the unresolved promise.
		progress.stop()
		const result = await promise
		expect(result).toEqual({ outcome: "skipped" })
	})

	it("promptGitToken resolves with submitted token after typing + Enter", async () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		const promise = progress.promptGitToken("github.com")
		const component = h.customCalls[0].component
		expect(component).toBeDefined()
		component?.handleInput?.("a")
		component?.handleInput?.("b")
		component?.handleInput?.("c")
		component?.handleInput?.("\r")
		const result = await promise
		expect(result).toEqual({ outcome: "submitted", token: "abc", save: true })
	})

	it("stop while a git-token prompt is mid-flight resolves it as skipped and closes once", async () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		const promise = progress.promptGitToken("github.com")
		progress.stop()
		const result = await promise
		expect(result).toEqual({ outcome: "skipped" })
		expect(h.customCalls[0].done).toHaveBeenCalledTimes(1)
	})

	it("promptGitToken after finish resolves immediately to skipped", async () => {
		const h = makeUi()
		const progress = createTeleportProgress(h.ui)
		progress.finish({ id: "ws1", url: "wss://x", description: "test" })
		const result = await progress.promptGitToken("github.com")
		expect(result).toEqual({ outcome: "skipped" })
	})

	it("buffers early step calls until the factory mounts the panel", () => {
		const h = makeUi("manual")
		const progress = createTeleportProgress(h.ui)
		// Factory hasn't run yet; mutations should buffer without throwing.
		progress.step("Authenticating")
		progress.complete("Authenticated")
		progress.step("Preparing sandbox")
		// Mount the panel — buffered ops should flush.
		h.mountPending()
		const lines = h.customCalls[0].component?.render(80) ?? []
		const joined = lines.join("\n")
		expect(joined).toContain("Authenticated")
		expect(joined).toContain("Preparing sandbox")
	})
})
