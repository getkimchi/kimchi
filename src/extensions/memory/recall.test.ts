/**
 * Unit tests for the shared recall pipeline (recall.ts): gate outcomes,
 * failure-valve classification, steer injection, and the cross-path
 * delivered-ledger bookkeeping. Mocks replace the searcher and the d3
 * gate; no network.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RecallDeadline } from "./deadline.js"
import type { MemorySearchHit } from "./inject.js"
import {
	buildLoopRecallQueries,
	buildLoopRecallQuery,
	type RecallCompletion,
	type RecallRunArgs,
	runRecall,
	stateFingerprint,
} from "./recall.js"

const hit = (text: string, score = 0.9): MemorySearchHit => ({ memory: text, score }) as MemorySearchHit

interface Rig {
	pi: ExtensionAPI
	ctx: ExtensionContext
	sent: unknown[]
	emitted: Array<Record<string, unknown>>
	deliveredFacts: string[]
	deliveredKeys: Set<string>
	completions: RecallCompletion[]
}

function makeRig(): Rig {
	const sent: unknown[] = []
	const emitted: Array<Record<string, unknown>> = []
	const pi = { sendMessage: (m: unknown) => sent.push(m) } as unknown as ExtensionAPI
	const ctx = { hasUI: false } as unknown as ExtensionContext
	return { pi, ctx, sent, emitted, deliveredFacts: [], deliveredKeys: new Set(), completions: [] }
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
		emit: (partial) => {
			rig.emitted.push(partial)
		},
		onComplete: (completion) => rig.completions.push(completion),
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
		expect(rig.emitted).toEqual([
			expect.objectContaining({
				trigger: "user-turn",
				gate: { lookup: "skip" },
				hits: [],
				injected: [],
				conclusion: "gate-skip",
			}),
		])
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
		// the trace carries the per-facet breakdown (dashboard facet column)
		expect(rig.emitted[0].facets).toEqual([
			{ text: "facet-plan", hits: 2 },
			{ text: "facet-state", hits: 2 },
		])
	})

	it("keeps useful hits when another facet returns an empty/null result", async () => {
		const rig = makeRig()
		const outcome = await runRecall(
			baseArgs(rig, {
				queries: ["empty facet", "useful facet"],
				search: async (query) => (query === "empty facet" ? null : [hit("useful fact")]),
			}),
		)
		expect(outcome).toBe("injected")
		expect(rig.deliveredFacts).toEqual(["useful fact"])
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
		const outcome = await runRecall(
			baseArgs(rig, { search: async () => [{ ...hit("a durable preference"), id: "fact-1" }] }),
		)
		expect(outcome).toBe("injected")
		expect(rig.sent).toHaveLength(1)
		const msg = rig.sent[0] as { customType: string; content: Array<{ text: string }>; display: boolean }
		expect(msg.customType).toBe("memory-recall")
		expect(msg.display).toBe(false)
		expect(msg.content[0].text).toContain("[User memory — recalled from previous sessions]")
		expect(rig.deliveredFacts).toContain("a durable preference")
		expect(rig.deliveredKeys.size).toBe(1)
		expect(rig.emitted).toHaveLength(2)
		expect(rig.emitted[0]).toMatchObject({
			trigger: "user-turn",
			selected: ["a durable preference"],
			injected: [],
			steered: false,
			conclusion: "selected",
		})
		expect(rig.emitted[1]).toMatchObject({
			trigger: "user-turn",
			injected: ["a durable preference"],
			steered: true,
			conclusion: "steered",
		})
		expect(rig.emitted[0].recall_id).toBe(rig.emitted[1].recall_id)
		expect(rig.emitted[0].selectedIds).toEqual(["fact-1"])
		expect(rig.emitted[1].injectedIds).toEqual(["fact-1"])
	})

	it("does not send if delivery permission is lost after selection", async () => {
		const rig = makeRig()
		const deadline = new RecallDeadline({
			scheduledStep: "user-turn",
			generation: 1,
			timeoutMs: 1_000,
			id: "permission-lost",
		})
		const outcome = await runRecall(
			baseArgs(rig, {
				deadline,
				search: async () => [hit("a durable preference")],
				emit: (partial) => {
					rig.emitted.push(partial)
					if (partial.selected) deadline.cancel("droppedStale")
				},
			}),
		)
		expect(outcome).toBe("droppedStale")
		expect(rig.sent).toHaveLength(0)
		expect(rig.deliveredFacts).toEqual([])
		deadline.dispose()
	})

	it("records a steer accepted before the delivery-notification cancellation", async () => {
		const rig = makeRig()
		const deadline = new RecallDeadline({
			scheduledStep: "user-turn",
			generation: 1,
			timeoutMs: 1_000,
			id: "accepted-send",
		})
		const pi = { sendMessage: () => deadline.cancel("droppedStale") } as unknown as ExtensionAPI
		const outcome = await runRecall(
			baseArgs(rig, {
				deadline,
				pi,
				search: async () => [{ ...hit("a durable preference"), id: "fact-1" }],
			}),
		)
		expect(outcome).toBe("injected")
		expect(rig.deliveredFacts).toEqual(["a durable preference"])
		expect(deadline.status).toBe("steered")
		expect(rig.emitted.at(-1)).toMatchObject({
			recall_id: "accepted-send",
			conclusion: "steered",
			injectedIds: ["fact-1"],
		})
		deadline.dispose()
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

	it("a send failure has a selected trace but no delivery or ledger mutation", async () => {
		const rig = makeRig()
		const pi = {
			sendMessage: () => {
				throw new Error("replaced session")
			},
		} as unknown as ExtensionAPI
		const outcome = await runRecall(baseArgs(rig, { pi, search: async () => [hit("a durable preference")] }))
		expect(outcome).toBe("failed")
		expect(rig.emitted[0]).toMatchObject({ conclusion: "selected", injected: [], steered: false })
		expect(rig.emitted.at(-1)).toMatchObject({
			conclusion: "unreachable",
			injected: [],
			steered: false,
			error: "replaced session",
		})
		expect(rig.deliveredFacts).toEqual([])
		expect(rig.deliveredKeys.size).toBe(0)
	})

	it("a stale generation cancels before search and never mutates delivery state", async () => {
		const rig = makeRig()
		const deadline = new RecallDeadline({ scheduledStep: "user-turn", generation: 1, timeoutMs: 100 })
		deadline.cancel("droppedStale")
		const searched = vi.fn(async () => [hit("late fact")])
		const outcome = await runRecall(baseArgs(rig, { deadline, search: searched }))
		expect(outcome).toBe("droppedStale")
		expect(searched).not.toHaveBeenCalled()
		expect(rig.emitted.at(-1)).toMatchObject({
			recall_id: deadline.id,
			generation: 1,
			conclusion: "droppedStale",
			injected: [],
		})
		expect(rig.deliveredFacts).toEqual([])
		deadline.dispose()
	})

	it("a timeout aborts the request and emits timed-out, not no-hits or injected", async () => {
		const rig = makeRig()
		const deadline = new RecallDeadline({ scheduledStep: "user-turn", generation: 1, timeoutMs: 0 })
		const outcome = await runRecall(
			baseArgs(rig, {
				deadline,
				search: (_query) =>
					new Promise((_resolve, reject) => {
						deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true })
					}),
			}),
		)
		expect(outcome).toBe("timed-out")
		expect(rig.emitted.at(-1)).toMatchObject({ conclusion: "timed-out", injected: [], steered: false })
		expect(rig.deliveredFacts).toEqual([])
		deadline.dispose()
	})

	it("bounds even a search implementation that ignores AbortSignal", async () => {
		const rig = makeRig()
		const deadline = new RecallDeadline({ scheduledStep: "user-turn", generation: 1, timeoutMs: 0 })
		const outcome = await runRecall(baseArgs(rig, { deadline, search: () => new Promise(() => {}) }))
		expect(outcome).toBe("timed-out")
		expect(rig.emitted.at(-1)).toMatchObject({ conclusion: "timed-out", injected: [], steered: false })
		deadline.dispose()
	})

	it("a provider rejection after cancellation is cancelled, not a permanent recall failure", async () => {
		const rig = makeRig()
		const deadline = new RecallDeadline({ scheduledStep: "user-turn", generation: 1, timeoutMs: 100 })
		let rejectRequest: ((error: Error) => void) | undefined
		const pending = runRecall(
			baseArgs(rig, {
				deadline,
				search: () =>
					new Promise((_resolve, reject) => {
						rejectRequest = reject
					}),
			}),
		)
		deadline.cancel("cancelled")
		rejectRequest?.(new Error("provider closed the request"))
		await expect(pending).resolves.toBe("cancelled")
		expect(rig.emitted.at(-1)).toMatchObject({ conclusion: "cancelled", injected: [], steered: false })
		expect(rig.deliveredFacts).toEqual([])
		deadline.dispose()
	})
})

describe("runRecall completion telemetry", () => {
	beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}))
	afterEach(() => vi.restoreAllMocks())

	it("reports covered and gate outcomes without searches or hidden text", () => {
		return (async () => {
			const coveredRig = makeRig()
			coveredRig.deliveredFacts.push("a distinctly uncovered topic")
			await runRecall(baseArgs(coveredRig))
			expect(coveredRig.completions).toEqual([
				expect.objectContaining({
					outcome: "covered",
					delivery: "none",
					gateStatus: "not_run",
					searchCount: 0,
					selectedCount: 0,
					deliveredCount: 0,
				}),
			])

			const skippedRig = makeRig()
			await runRecall(baseArgs(skippedRig, { decideGate: async () => true }))
			expect(skippedRig.completions[0]).toMatchObject({ outcome: "gate-skip", gateStatus: "skipped", searchCount: 0 })
			for (const completion of [...coveredRig.completions, ...skippedRig.completions]) {
				expect(completion).not.toHaveProperty("query")
				expect(completion).not.toHaveProperty("hits")
				expect(completion).not.toHaveProperty("selected")
			}
		})()
	})

	it("records a degraded gate and all multi-facet selection/delivery counts", async () => {
		const rig = makeRig()
		vi.spyOn(console, "error").mockImplementation(() => {})
		await expect(
			runRecall(
				baseArgs(rig, {
					trigger: "step-budget",
					queries: ["facet-plan", "facet-state"],
					decideGate: async () => {
						throw new Error("gate down")
					},
					search: async (query) =>
						query === "facet-plan" ? [hit("plan one", 0.8), hit("plan two", 0.7)] : [hit("state three", 0.6)],
				}),
			),
		).resolves.toBe("injected")
		expect(rig.completions).toEqual([
			expect.objectContaining({
				outcome: "injected",
				delivery: "steered",
				gateStatus: "degraded",
				searchCount: 2,
				consideredCount: 3,
				selectedCount: 3,
				deliveredCount: 3,
				durationMs: expect.any(Number),
			}),
		])
		expect(rig.completions[0]?.composition).toMatchObject({ considered: 3, facts: 3 })
	})

	it("reports no-searcher explicitly without inventing candidate counts", async () => {
		const rig = makeRig()
		await expect(runRecall(baseArgs(rig, { queries: ["a", "b"], search: async () => undefined }))).resolves.toBe(
			"no-searcher",
		)
		expect(rig.completions[0]).toMatchObject({
			outcome: "no-searcher",
			searchCount: 2,
			consideredCount: 0,
			selectedCount: 0,
			deliveredCount: 0,
		})
	})

	it("keeps selected and accepted delivery distinct on a send failure", async () => {
		const rig = makeRig()
		const pi = {
			sendMessage: () => {
				throw new Error("replaced session")
			},
		} as unknown as ExtensionAPI
		await expect(runRecall(baseArgs(rig, { pi, search: async () => [hit("a durable preference")] }))).resolves.toBe(
			"failed",
		)
		expect(rig.completions[0]).toMatchObject({
			outcome: "failed",
			delivery: "none",
			selectedCount: 1,
			deliveredCount: 0,
		})
	})

	it("fails open when the completion reporter throws", async () => {
		const rig = makeRig()
		vi.spyOn(console, "error").mockImplementation(() => {})
		await expect(
			runRecall(
				baseArgs(rig, {
					search: async () => [hit("still delivered")],
					onComplete: () => {
						throw new Error("telemetry unavailable")
					},
				}),
			),
		).resolves.toBe("injected")
		expect(rig.deliveredFacts).toEqual(["still delivered"])
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

	it("keeps only the newest distinct context facet after the evidence", () => {
		const facets = buildLoopRecallQueries(
			"aim: plan",
			["state: room A"],
			["user said follow the wall", "previous note: door is stuck"],
		)
		expect(facets).toEqual(["aim: plan", "state: room A", "previous note: door is stuck"])
	})

	it("bounds a large mixed need to at most three facets", () => {
		const facets = buildLoopRecallQueries(
			"decide the next action",
			["old state", "new state"],
			["one old turn", "the newest need"],
		)
		expect(facets).toEqual(["decide the next action", "new state", "the newest need"])
	})

	it("turn texts slice to the per-facet char budget", () => {
		const facets = buildLoopRecallQueries("", [], ["x".repeat(500)])
		expect(facets).toHaveLength(1)
		expect(facets[0].length).toBeLessThanOrEqual(160)
	})

	it("exact-duplicate turn texts dedupe against earlier facets", () => {
		const facets = buildLoopRecallQueries("aim: plan", [], ["aim: plan", "aim: plan"])
		expect(facets).toEqual(["aim: plan"])
	})

	it("no recent turns keeps the legacy facet shape", () => {
		expect(buildLoopRecallQueries("aim: plan", ["state: room A"])).toEqual(["aim: plan", "state: room A"])
		expect(buildLoopRecallQuery("aim: plan", ["state: room A"], [])).toBe("aim: plan\nstate: room A")
	})
})
