import { describe, expect, it } from "vitest"
import { deriveBannerState } from "./overlay-component.js"
import type { Tab } from "./tab-manager.js"

function makeTab(over: Partial<Tab>): Tab {
	return {
		id: over.id ?? "tab-1",
		session: over.session ?? {
			name: "s1",
			agentMode: "PTY",
			alive: true,
			agentRunning: false,
			clientConnected: false,
			connectedThroughBridge: false,
		},
		transport: undefined as unknown as Tab["transport"],
		core: undefined as unknown as Tab["core"],
		component: undefined as unknown as Tab["component"],
		dirty: over.dirty ?? false,
		connectionStatus: over.connectionStatus ?? "connecting",
		reconnectInfo: over.reconnectInfo,
		fatalInfo: over.fatalInfo,
	}
}

describe("deriveBannerState", () => {
	it("returns null when no active tab", () => {
		expect(deriveBannerState(undefined)).toBeNull()
	})

	it("returns null when the tab is open", () => {
		expect(deriveBannerState(makeTab({ connectionStatus: "open" }))).toBeNull()
	})

	it("returns connecting state for an unconnected tab with no other info", () => {
		expect(deriveBannerState(makeTab({ connectionStatus: "connecting" }))).toEqual({
			phase: "connecting",
		})
	})

	it("returns reconnecting state with a live countdown derived from startedAt + delayMs", () => {
		const now = Date.now()
		const state = deriveBannerState(
			makeTab({
				connectionStatus: "reconnecting",
				reconnectInfo: { attempt: 2, delayMs: 4000, startedAt: now },
			}),
		)
		expect(state?.phase).toBe("reconnecting")
		expect(state?.reconnect?.attempt).toBe(2)
		// secondsRemaining should be ~4 (give a 1s window for test timing).
		expect(state?.reconnect?.secondsRemaining).toBeGreaterThanOrEqual(3)
		expect(state?.reconnect?.secondsRemaining).toBeLessThanOrEqual(4)
	})

	it("clamps countdown at 0 when the delay has already elapsed", () => {
		const state = deriveBannerState(
			makeTab({
				connectionStatus: "reconnecting",
				reconnectInfo: { attempt: 1, delayMs: 1000, startedAt: Date.now() - 5000 },
			}),
		)
		expect(state?.reconnect?.secondsRemaining).toBe(0)
	})

	it("maps recoverable fatal to phase='lost'", () => {
		const state = deriveBannerState(
			makeTab({
				connectionStatus: "fatal",
				fatalInfo: { code: 1006, reason: "gave up after 300s", recoverable: true },
			}),
		)
		expect(state).toEqual({
			phase: "lost",
			fatal: { code: 1006, reason: "gave up after 300s" },
		})
	})

	it("maps non-recoverable fatal to phase='fatal'", () => {
		const state = deriveBannerState(
			makeTab({
				connectionStatus: "fatal",
				fatalInfo: { code: 4003, reason: "session finished", recoverable: false },
			}),
		)
		expect(state).toEqual({
			phase: "fatal",
			fatal: { code: 4003, reason: "session finished" },
		})
	})

	it("prefers fatal over reconnect when both are present", () => {
		const state = deriveBannerState(
			makeTab({
				connectionStatus: "fatal",
				reconnectInfo: { attempt: 5, delayMs: 1000, startedAt: Date.now() },
				fatalInfo: { code: 4003, reason: "session finished", recoverable: false },
			}),
		)
		expect(state?.phase).toBe("fatal")
	})
})
