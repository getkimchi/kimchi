import { describe, expect, it, vi } from "vitest"
import type { AgentManager } from "../manager/agent-manager.js"
import type { LifetimeUsage } from "../manager/usage.js"
import { type AgentActivity, AgentWidget, type Theme, type UICtx } from "./agent-widget.js"

// The widget remounts the tips widget when it registers — the tips module
// pulls in config/billing/ferment chains a unit test doesn't need.
vi.mock("../../tips/index.js", () => ({ remountTipWidget: vi.fn() }))

const theme: Theme = { fg: (_color, text) => text, bold: (text) => text }

const ZERO_USAGE: LifetimeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function makeActivity(lifetimeUsage: LifetimeUsage): AgentActivity {
	return {
		activeTools: new Map(),
		toolUses: 0,
		responseText: "",
		turnCount: 2,
		lifetimeUsage,
	}
}

function renderOnce(manager: AgentManager, activity: Map<string, AgentActivity>, markFinishedId?: string): string {
	const widget = new AgentWidget(manager, activity)
	let lines: string[] = []
	const uiCtx: UICtx = {
		setStatus: () => {},
		setWidget: (_key, content) => {
			if (content) lines = content(undefined, theme).render(120)
		},
	}
	widget.setUICtx(uiCtx)
	if (markFinishedId) widget.markFinished(markFinishedId)
	widget.update()
	return lines.join("\n")
}

describe("AgentWidget token display", () => {
	it("finished agent lines show the record's lifetime tokens", () => {
		const record = {
			id: "fin-1",
			type: "general-purpose",
			description: "did things",
			status: "completed",
			visibility: "user",
			toolUses: 3,
			startedAt: 1_000,
			completedAt: 2_000,
			lifetimeUsage: { input: 1500, output: 500, cacheRead: 0, cacheWrite: 0 },
		}
		const manager = { listAgents: () => [record] } as unknown as AgentManager

		const rendered = renderOnce(manager, new Map(), "fin-1")

		expect(rendered).toContain("3 tool uses")
		// 1500 input + 500 output = 2000 → "2.0k token", same order as the
		// running line (turns · tool uses · tokens · duration).
		expect(rendered).toContain("2.0k token")
		expect(rendered).toContain("1.0s")
	})

	it("finished agent lines omit token text when nothing was consumed", () => {
		const record = {
			id: "fin-2",
			type: "general-purpose",
			description: "did nothing",
			status: "completed",
			visibility: "user",
			toolUses: 0,
			startedAt: 1_000,
			completedAt: 2_000,
			lifetimeUsage: ZERO_USAGE,
		}
		const manager = { listAgents: () => [record] } as unknown as AgentManager

		const rendered = renderOnce(manager, new Map(), "fin-2")

		expect(rendered).not.toContain("token")
	})

	it("running agent lines show live activity tokens", () => {
		const record = {
			id: "run-1",
			type: "general-purpose",
			description: "working",
			status: "running",
			visibility: "user",
			toolUses: 0,
			startedAt: Date.now() - 5_000,
			lifetimeUsage: ZERO_USAGE,
		}
		const manager = { listAgents: () => [record] } as unknown as AgentManager
		const activity = new Map<string, AgentActivity>([
			["run-1", makeActivity({ input: 2500, output: 500, cacheRead: 0, cacheWrite: 0 })],
		])

		const rendered = renderOnce(manager, activity)

		expect(rendered).toContain("3.0k token")
		expect(rendered).toContain("⟳2")
	})

	it("running agent lines show the context percent alone when usage totals are absent (old server)", () => {
		const record = {
			id: "run-2",
			type: "general-purpose",
			description: "working on old server",
			status: "running",
			visibility: "user",
			toolUses: 0,
			startedAt: Date.now() - 5_000,
			lifetimeUsage: ZERO_USAGE,
		}
		const manager = { listAgents: () => [record] } as unknown as AgentManager
		const session = {
			getSessionStats: () => ({
				tokens: ZERO_USAGE,
				contextUsage: { percent: 42 },
			}),
		}
		const activity = new Map<string, AgentActivity>([["run-2", { ...makeActivity(ZERO_USAGE), session }]])

		const rendered = renderOnce(manager, activity)

		// Percent renders standalone — no "0 token" placeholder.
		expect(rendered).toContain("42%")
		expect(rendered).not.toContain("token")
	})
})
