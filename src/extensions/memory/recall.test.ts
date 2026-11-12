/**
 * Unit tests for the shared recall pipeline (recall.ts): gate outcomes,
 * failure-valve classification, steer injection, and the cross-path
 * delivered-ledger bookkeeping. Mocks replace the searcher and the d3
 * gate; no network.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MemorySearchHit } from "./inject.js"
import { buildLoopRecallQuery, type RecallRunArgs, runRecall, stateFingerprint } from "./recall.js"

const hit = (text: string, score = 0.9): MemorySearchHit => ({ memory: text, score }) as MemorySearchHit

interface Rig {
	pi: ExtensionAPI
	ctx: ExtensionContext
	sent: unknown[]
	emitted: Array<Record<string, unknown>>
	deliveredFacts: string[]
	deliveredKeys: Set<string>
}

function makeRig(): Rig {
	const sent: unknown[] = []
	const emitted: Array<Record<string, unknown>> = []
	const pi = { sendMessage: (m: unknown) => sent.push(m) } as unknown as ExtensionAPI
	const ctx = { hasUI: false } as unknown as ExtensionContext
	return { pi, ctx, sent, emitted, deliveredFacts: [], deliveredKeys: new Set() }
}

function baseArgs(rig: Rig, overrides: Partial<RecallRunArgs> = {}): RecallRunArgs {
	return {
		trigger: "user-turn",
		query: "a distinctly uncovered topic",
		pi: rig.pi,
		ctx: rig.ctx,
		search: async () => [],
		/** per-facet searches receive the facet text */
		queries: undefined,
		decideGate: null,
		deliveredFacts: rig.deliveredFacts,
		deliveredKeys: rig.deliveredKeys,
		emit: (partial) => rig.emitted.push(partial),
		...overrides,
	}
}

describe("runRecall", () => {
	beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}))
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("returns covered and skips gate+search when the conversation is covered", async () => {
		const rig = makeRig()
		rig.deliveredFacts.push("a distinctly uncovered topic") // exact containment path
		let searched = 0
		const outcome = await runRecall(
			baseArgs(rig, {
				search: async () => {
					searched++
					return []
				},
			}),
		)
		expect(outcome).toBe("covered")
		expect(searched).toBe(0)
		expect(rig.emitted).toHaveLength(0)
		expect(rig.sent).toHaveLength(0)
	})

	it("returns gate-skip and traces the trigger when the gate says skip", async () => {
		const rig = makeRig()
		let searched = 0
		const outcome = await runRecall(
			baseArgs(rig, {
				decideGate: async () => true,
				search: async () => {
					searched++
					return []
				},
			}),
		)
		expect(outcome).toBe("gate-skip")
		expect(searched).toBe(0)
		expect(rig.emitted).toEqual([{ trigger: "user-turn", gate: { lookup: "skip" }, hits: [], injected: [] }])
	})

	it("a throwing gate falls back to search (pre-gate behavior)", async () => {
		const rig = makeRig()
		vi.spyOn(console, "error").mockImplementation(() => {})
		const outcome = await runRecall(
			baseArgs(rig, {
				decideGate: async () => {
					throw new Error("gate down")
				},
				search: async () => [hit("fresh fact one")],
			}),
		)
		expect(outcome).toBe("injected")
		expect(rig.deliveredFacts).toContain("fresh fact one")
	})

	it("a throwing search returns failed and traces the error with trigger", async () => {
		const rig = makeRig()
		const outcome = await runRecall(
			baseArgs(rig, {
				trigger: "step-budget",
				search: async () => {
					throw new Error("store unreachable")
				},
			}),
		)
		expect(outcome).toBe("failed")
		expect(rig.emitted).toHaveLength(1)
		expect(rig.emitted[0].trigger).toBe("step-budget")
		expect(rig.emitted[0].error).toBe("store unreachable")
		expect(rig.sent).toHaveLength(0)
		expect(rig.deliveredFacts).toEqual([])
	})

	it("multi-facet lookups run one search per facet and merge hits by best score", async () => {
		const rig = makeRig()
		const seen: string[] = []
		const outcome = await runRecall(
			baseArgs(rig, {
				trigger: "step-budget",
				queries: ["facet-plan", "facet-state"],
				search: async (q) => {
					seen.push(q)
					if (q === "facet-plan") return [hit("shared fact", 0.5), hit("plan-side fact")]
					return [hit("shared fact", 0.9), hit("state-side fact")]
				},
			}),
		)
		expect(seen).toEqual(["facet-plan", "facet-state"])
		expect(outcome).toBe("injected")
		// merged by text, best score winning
		const emitted = rig.emitted[0].hits as Array<{ text: string; score: number }>
		const shared = emitted.find((h) => h.text === "shared fact")
		expect(shared?.score).toBe(0.9)
		expect(emitted).toHaveLength(3)
	})

	it("an undefined result from any facet is an overall no-searcher skip", async () => {
		const rig = makeRig()
		const outcome = await runRecall(
			baseArgs(rig, { queries: ["a", "b"], search: async (q) => (q === "a" ? [hit("x")] : undefined) }),
		)
		expect(outcome).toBe("no-searcher")
		expect(rig.emitted).toHaveLength(0)
	})

	it("null search result is a traced no-hits, not a silent skip", async () => {
		const rig = makeRig()
		const outcome = await runRecall(baseArgs(rig, { search: async () => null }))
		expect(outcome).toBe("no-hits")
		expect(rig.emitted).toHaveLength(1)
		expect(rig.emitted[0].hits).toEqual([])
		expect(rig.sent).toHaveLength(0)
	})

	it("undefined search returns no-searcher with no trace", async () => {
		const rig = makeRig()
		const outcome = await runRecall(baseArgs(rig, { search: async () => undefined }))
		expect(outcome).toBe("no-searcher")
		expect(rig.emitted).toHaveLength(0)
	})

	it("injects a steer, seeds the shared ledger, and traces hits/composition", async () => {
		const rig = makeRig()
		const outcome = await runRecall(baseArgs(rig, { search: async () => [hit("a durable preference")] }))
		expect(outcome).toBe("injected")
		expect(rig.sent).toHaveLength(1)
		const msg = rig.sent[0] as { customType: string; content: Array<{ text: string }>; display: boolean }
		expect(msg.customType).toBe("memory-recall")
		expect(msg.display).toBe(false)
		expect(msg.content[0].text).toContain("[User memory — recalled from previous sessions]")
		expect(rig.deliveredFacts).toContain("a durable preference")
		expect(rig.deliveredKeys.size).toBe(1)
		expect(rig.emitted).toHaveLength(1)
		expect(rig.emitted[0].trigger).toBe("user-turn")
		expect((rig.emitted[0].hits as Array<{ text: string }>)[0].text).toBe("a durable preference")
		expect(rig.emitted[0].injected).toEqual(["a durable preference"])
	})

	it("a second recall with only already-delivered facts returns no-hits (cross-path dedupe)", async () => {
		const rig = makeRig()
		await runRecall(baseArgs(rig, { trigger: "user-turn", search: async () => [hit("repurposed fact")] }))
		rig.emitted.length = 0
		const outcome = await runRecall(
			baseArgs(rig, { trigger: "step-budget", search: async () => [hit("repurposed fact")] }),
		)
		expect(outcome).toBe("no-hits")
		expect(rig.sent).toHaveLength(1) // only the first
		expect(rig.emitted[0].trigger).toBe("step-budget")
		expect(rig.emitted[0].injected).toEqual([])
	})
})

describe("stateFingerprint", () => {
	it("two passes through the same state at different depths hash equal", () => {
		const a = stateFingerprint("step 3\nroom: grey hall\ninventory: key")
		const b = stateFingerprint("step 8\nroom: grey hall\ninventory: key")
		expect(a).toBeDefined()
		expect(a).toBe(b)
	})

	it("volatile-labelled lines keep equal hashes; content lines do not", () => {
		expect(stateFingerprint("attempt 1 of 4\nwest wing")).toBe(stateFingerprint("attempt 3 of 4\nwest wing"))
		expect(stateFingerprint("step 1\nwest wing")).not.toBe(stateFingerprint("step 1\neast wing"))
	})

	it("blank and whitespace-only content yields no fingerprint", () => {
		expect(stateFingerprint("")).toBeUndefined()
		expect(stateFingerprint("  \n \t\n")).toBeUndefined()
	})

	it("digits on non-volatile lines are part of the state", () => {
		expect(stateFingerprint("gps 51.5007, -0.1246\nsky grey")).not.toBe(
			stateFingerprint("gps 48.8566, 2.3522\nsky grey"),
		)
	})
})

describe("buildLoopRecallQuery", () => {
	it("keeps both ends of a long receipt — state head AND echo tail survive", () => {
		const receipt = `badges=0 party=0 level=12\n${"map-row ".repeat(120)}\npressed: down,down,down`
		const query = buildLoopRecallQuery("aim: leave the room", [receipt])
		expect(query).toContain("aim: leave the room")
		expect(query).toContain("badges=0 party=0 level=12")
		expect(query).toContain("pressed: down,down,down")
		expect(query).toContain("…")
	})

	it("a short receipt passes through uncut; the reasoning head stays first", () => {
		const query = buildLoopRecallQuery("plan sentence", ["state: room A"])
		expect(query).toBe("plan sentence\nstate: room A")
	})

	it("with no receipts the reasoning head alone fills the query", () => {
		expect(buildLoopRecallQuery("just the plan", [])).toBe("just the plan")
	})

	it("the query respects the total budget with a wide head and two receipts", () => {
		const query = buildLoopRecallQuery("h".repeat(900), [`${"a".repeat(900)}\n${"z".repeat(900)}`])
		expect(query.length).toBeLessThanOrEqual(2000)
	})
})
