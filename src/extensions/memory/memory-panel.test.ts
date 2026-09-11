import { describe, expect, it, vi } from "vitest"
import { computeMemoryWindow, MemoryPanel, type MemoryPanelFact } from "./memory-panel.js"

const fact = (id: string, memory: string, scopeId = "personal"): MemoryPanelFact => ({
	id,
	memory,
	scopeId,
	createdAt: `2026-09-0${(Number(id.at(-1)) % 9) + 1}`,
})

/** Strip ANSI escapes so assertions see the text. */
const plain = (lines: string[]): string[] =>
	lines.map((l) =>
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC byte is the point — this strips ANSI escapes.
		l.replace(/\x1b\[[0-9;]*m/g, ""),
	)

interface Harness {
	panel: MemoryPanel
	done: ReturnType<typeof vi.fn>
	deleteFact: ReturnType<typeof vi.fn>
}

function makePanel(facts: MemoryPanelFact[], deleteFact?: Harness["deleteFact"]): Harness {
	const done = vi.fn()
	const resolvedDelete: Harness["deleteFact"] = deleteFact ?? vi.fn(async () => "personal")
	const panel = new MemoryPanel({
		title: "Memory — test",
		facts,
		deleteFact: resolvedDelete,
		tui: { requestRender: vi.fn(), terminal: { rows: 24 } },
		done,
	})
	return { panel, done, deleteFact: resolvedDelete }
}

const rendered = (panel: MemoryPanel): string => plain(panel.render(80)).join("\n")

const selectedLine = (panel: MemoryPanel): string => plain(panel.render(80)).find((l) => l.includes("→")) ?? ""

describe("computeMemoryWindow", () => {
	it("adapts to the terminal and keeps the cursor centered", () => {
		expect(computeMemoryWindow(24, 0, 50)).toEqual({ maxVis: 16, startIdx: 0, endIdx: 16 })
		expect(computeMemoryWindow(24, 25, 50)).toEqual({ maxVis: 16, startIdx: 17, endIdx: 33 })
		expect(computeMemoryWindow(24, 49, 50)).toEqual({ maxVis: 16, startIdx: 34, endIdx: 50 })
	})

	it("clamps to the minimum on tiny terminals", () => {
		expect(computeMemoryWindow(5, 0, 50)).toEqual({ maxVis: 3, startIdx: 0, endIdx: 3 })
	})
})

describe("MemoryPanel", () => {
	it("renders the title, fact rows, and key legend", () => {
		const { panel } = makePanel([fact("1", "the user's dog is named Fred")])
		const text = rendered(panel)
		expect(text).toContain("Memory — test")
		expect(text).toContain("the user's dog is named Fred")
		expect(text).toContain("d delete")
		expect(text).toContain("Deletion is immediate and permanent.")
		expect(plain(panel.render(80))[0]).toContain("╭")
	})

	it("moves the cursor with arrows and j/k", () => {
		const { panel } = makePanel([fact("1", "alpha"), fact("2", "beta"), fact("3", "gamma")])
		expect(selectedLine(panel)).toContain("alpha")
		panel.handleInput("\x1b[B") // down
		expect(selectedLine(panel)).toContain("beta")
		panel.handleInput("j")
		expect(selectedLine(panel)).toContain("gamma")
		panel.handleInput("k")
		expect(selectedLine(panel)).toContain("beta")
		panel.handleInput("\x1b[A") // up
		expect(selectedLine(panel)).toContain("alpha")
		// The cursor clamps at both ends.
		panel.handleInput("\x1b[A")
		expect(selectedLine(panel)).toContain("alpha")
	})

	it("g/G jump to the top/end", () => {
		const { panel } = makePanel([fact("1", "alpha"), fact("2", "beta"), fact("3", "gamma")])
		panel.handleInput("G") // arrives as shift+g
		expect(selectedLine(panel)).toContain("gamma")
		panel.handleInput("g")
		expect(selectedLine(panel)).toContain("alpha")
	})

	it("windows long lists with a more-facts hint", () => {
		const facts = Array.from({ length: 50 }, (_, i) => fact(String(i), `fact number ${i}`))
		const { panel } = makePanel(facts)
		const text = rendered(panel)
		expect(text).toContain("1/50")
		expect(text).toContain("more (PgDn")
		// PageDown moves by the window size and the counter follows.
		panel.handleInput("\x1b[6~") // pageDown
		expect(rendered(panel)).toContain("17/50")
	})

	it("d deletes the selected fact — optimistic, then confirmed", async () => {
		const { panel, deleteFact } = makePanel([fact("1", "alpha"), fact("2", "beta")])
		panel.handleInput("\x1b[B") // select beta
		panel.handleInput("d")
		expect(deleteFact).toHaveBeenCalledWith("2")
		expect(rendered(panel)).not.toContain("beta")
		await new Promise((r) => setTimeout(r, 0))
		expect(rendered(panel)).toContain("Deleted from personal")
		// The notice clears on the next key.
		panel.handleInput("\x1b[B")
		expect(rendered(panel)).not.toContain("Deleted from personal")
	})

	it("a failed delete restores the fact and shows the error", async () => {
		const deleteFact = vi.fn(async () => {
			throw new Error("store unavailable")
		})
		const { panel } = makePanel([fact("1", "alpha"), fact("2", "beta")], deleteFact)
		panel.handleInput("d")
		await new Promise((r) => setTimeout(r, 0))
		const text = rendered(panel)
		expect(text).toContain("Delete failed: store unavailable")
		expect(text).toContain("alpha")
	})

	it("deleting the last fact clamps into the empty state", async () => {
		const { panel } = makePanel([fact("1", "only fact")])
		panel.handleInput("d")
		await new Promise((r) => setTimeout(r, 0))
		expect(rendered(panel)).toContain("No memories to show.")
	})

	it("q, escape, and ctrl+c close the panel", () => {
		for (const key of ["q", "\x1b", "\x03"]) {
			const { panel, done } = makePanel([fact("1", "alpha")])
			panel.handleInput(key)
			expect(done).toHaveBeenCalledTimes(1)
		}
	})

	it("an empty fact list renders the empty state", () => {
		const { panel } = makePanel([])
		expect(rendered(panel)).toContain("No memories to show.")
	})
})
