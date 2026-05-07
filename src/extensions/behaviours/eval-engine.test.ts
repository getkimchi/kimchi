import { describe, expect, it } from "vitest"
import { EVAL_SAMPLE_CAP, EvalEngine } from "./eval-engine.js"
import { type ToolCallEvent, tool } from "./triggers.js"
import type { Behaviour, BehaviourEvals } from "./types.js"

function makeBehaviour(args: { name: string; evals?: BehaviourEvals }): Behaviour {
	return {
		kind: "triggered",
		name: args.name,
		description: `${args.name} behaviour`,
		body: `body of ${args.name}`,
		triggers: {},
		evals: args.evals,
	}
}

function bashCall(command: string): ToolCallEvent {
	return { toolName: "bash", input: { command } }
}

const ghMatcher = tool("bash", (i) => i.command.startsWith("gh "))
const curlMatcher = tool("bash", (i) => i.command.startsWith("curl "))

describe("EvalEngine.evaluate", () => {
	it("emits an observed sample when the loaded behaviour's observed matcher fires", () => {
		const b = makeBehaviour({
			name: "gh-cli",
			evals: { observed: ghMatcher },
		})
		const engine = new EvalEngine([b], () => true)
		const events = engine.evaluate(bashCall("gh pr list"), 7)

		expect(events).toEqual([
			{
				name: "gh-cli",
				verdict: "observed",
				turnIndex: 7,
				toolName: "bash",
				toolArgs: { command: "gh pr list" },
			},
		])
	})

	it("emits a violated sample independent of observed", () => {
		const b = makeBehaviour({
			name: "gh-cli",
			evals: { observed: ghMatcher, violated: curlMatcher },
		})
		const engine = new EvalEngine([b], () => true)
		const events = engine.evaluate(bashCall("curl https://api.github.com/repos"), 0)

		expect(events.map((e) => e.verdict)).toEqual(["violated"])
	})

	it("emits both observed and violated when both matchers fire on the same call", () => {
		const matcher = tool("bash")
		const b = makeBehaviour({
			name: "x",
			evals: { observed: matcher, violated: matcher },
		})
		const engine = new EvalEngine([b], () => true)
		const events = engine.evaluate(bashCall("anything"), 0)
		expect(events.map((e) => e.verdict)).toEqual(["observed", "violated"])
	})

	it("does not score a behaviour that is not loaded", () => {
		const b = makeBehaviour({
			name: "gh-cli",
			evals: { observed: ghMatcher },
		})
		const engine = new EvalEngine([b], () => false)
		expect(engine.evaluate(bashCall("gh pr list"), 0)).toEqual([])
	})

	it("starts scoring a behaviour as soon as the isLoaded view returns true", () => {
		const loaded = new Set<string>()
		const b = makeBehaviour({
			name: "gh-cli",
			evals: { observed: ghMatcher },
		})
		const engine = new EvalEngine([b], (n) => loaded.has(n))

		expect(engine.evaluate(bashCall("gh pr list"), 0)).toEqual([])
		loaded.add("gh-cli")
		expect(engine.evaluate(bashCall("gh pr list"), 1)).toHaveLength(1)
	})

	it("stops emitting samples past the cap but keeps counters advancing", () => {
		const b = makeBehaviour({
			name: "gh-cli",
			evals: { observed: ghMatcher },
		})
		const engine = new EvalEngine([b], () => true)

		for (let i = 0; i < EVAL_SAMPLE_CAP; i++) {
			expect(engine.evaluate(bashCall("gh pr list"), i)).toHaveLength(1)
		}
		// 6th match: counter advances, no sample.
		expect(engine.evaluate(bashCall("gh pr list"), EVAL_SAMPLE_CAP)).toEqual([])
		// 7th match: still capped.
		expect(engine.evaluate(bashCall("gh pr list"), EVAL_SAMPLE_CAP + 1)).toEqual([])

		expect(engine.countersFor("gh-cli")).toEqual({
			observed: EVAL_SAMPLE_CAP + 2,
			violated: 0,
		})
	})

	it("caps observed and violated independently", () => {
		const b = makeBehaviour({
			name: "x",
			evals: { observed: ghMatcher, violated: curlMatcher },
		})
		const engine = new EvalEngine([b], () => true, 2)

		// Two observed samples, then capped.
		engine.evaluate(bashCall("gh a"), 0)
		engine.evaluate(bashCall("gh b"), 0)
		expect(engine.evaluate(bashCall("gh c"), 0)).toEqual([])

		// Violated still has its own budget.
		const v = engine.evaluate(bashCall("curl x"), 1)
		expect(v.map((e) => e.verdict)).toEqual(["violated"])
	})

	it("interleaves multiple behaviours without cross-talk", () => {
		const a = makeBehaviour({
			name: "a",
			evals: { observed: ghMatcher },
		})
		const b = makeBehaviour({
			name: "b",
			evals: { violated: curlMatcher },
		})
		const engine = new EvalEngine([a, b], () => true)

		const e1 = engine.evaluate(bashCall("gh pr list"), 0)
		expect(e1.map((e) => `${e.name}:${e.verdict}`)).toEqual(["a:observed"])

		const e2 = engine.evaluate(bashCall("curl https://x"), 1)
		expect(e2.map((e) => `${e.name}:${e.verdict}`)).toEqual(["b:violated"])
	})

	it("ignores behaviours without any evaluator slots", () => {
		const b = makeBehaviour({ name: "no-evals", evals: undefined })
		const engine = new EvalEngine([b], () => true)
		expect(engine.evaluate(bashCall("anything"), 0)).toEqual([])
	})
})

describe("EvalEngine.reset", () => {
	it("clears counters and re-opens the cap budget", () => {
		const b = makeBehaviour({
			name: "x",
			evals: { observed: ghMatcher },
		})
		const engine = new EvalEngine([b], () => true, 1)

		expect(engine.evaluate(bashCall("gh a"), 0)).toHaveLength(1)
		expect(engine.evaluate(bashCall("gh b"), 0)).toEqual([])
		engine.reset()
		expect(engine.countersFor("x")).toEqual({ observed: 0, violated: 0 })
		expect(engine.evaluate(bashCall("gh c"), 1)).toHaveLength(1)
	})
})
