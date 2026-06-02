import { describe, expect, it } from "vitest"
import type { Session } from "../../../sandbox/worker/types.js"
import { TabBar } from "./tab-bar.js"
import type { Tab, TabConnectionPhase } from "./tab-manager.js"

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
}

function makeSession(name: string): Session {
	return {
		name,
		agentMode: "PTY",
		alive: true,
		agentRunning: false,
		clientConnected: false,
		connectedThroughBridge: false,
	}
}

function makeTab(name: string, phase: TabConnectionPhase, dirty = false): Tab {
	return {
		id: name,
		session: makeSession(name),
		// transport/core/component aren't exercised by the tab bar.
		transport: undefined as unknown as Tab["transport"],
		core: undefined as unknown as Tab["core"],
		component: undefined as unknown as Tab["component"],
		dirty,
		connectionStatus: phase,
	}
}

function renderBar(tabs: Tab[], activeIndex: number, width = 80): string {
	const bar = new TabBar(() => ({ tabs, activeIndex }))
	const [line] = bar.render(width)
	return stripAnsi(line)
}

describe("TabBar status glyphs", () => {
	it("shows a leading space for clean open tabs", () => {
		const line = renderBar([makeTab("a", "open")], 0)
		expect(line.startsWith(" 1:a")).toBe(true)
	})

	it("shows a dirty dot when the tab is dirty and open", () => {
		const line = renderBar([makeTab("a", "open", true)], 0)
		expect(line.startsWith("•1:a")).toBe(true)
	})

	it("shows ⚠ for reconnecting tabs (degraded > dirty)", () => {
		const line = renderBar([makeTab("a", "reconnecting", true)], 0)
		expect(line.startsWith("⚠1:a")).toBe(true)
	})

	it("shows ⚠ for fatal tabs", () => {
		const line = renderBar([makeTab("a", "fatal")], 0)
		expect(line.startsWith("⚠1:a")).toBe(true)
	})

	it("does NOT show ⚠ for the initial connecting phase", () => {
		// Avoids a visual flicker on the very first paint before the open.
		const line = renderBar([makeTab("a", "connecting")], 0)
		expect(line.startsWith("⚠")).toBe(false)
	})

	it("shows ⚠ on inactive tabs too", () => {
		const line = renderBar([makeTab("a", "open"), makeTab("b", "reconnecting")], 0)
		expect(line).toContain("⚠2:b")
	})
})
