import { describe, expect, it } from "vitest"
import { TriggerEngine } from "./engine.js"
import type { SessionContext } from "./session-context.js"
import { any, cli, gitRemote } from "./triggers.js"
import type { Behaviour } from "./types.js"

function makeBehaviour(overrides: Partial<Behaviour> & Pick<Behaviour, "name" | "kind">): Behaviour {
	return {
		description: `${overrides.name} behaviour`,
		body: `body of ${overrides.name}`,
		triggers: undefined,
		...overrides,
	}
}

function makeContext(
	overrides: Partial<{
		clis: Iterable<string>
		gitRemoteHost: string | undefined
		paths: Iterable<string>
	}> = {},
): SessionContext {
	return {
		cliPresent: new Set(overrides.clis ?? []),
		gitRemoteHost: overrides.gitRemoteHost,
		pathMatches: new Set(overrides.paths ?? []),
	}
}

describe("TriggerEngine.evaluateSessionTriggers", () => {
	it("loads a triggered behaviour when its session probe matches", () => {
		const ghCli = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: { session: any(cli("gh"), gitRemote("github.com")) },
		})
		const engine = new TriggerEngine([ghCli])
		const events = engine.evaluateSessionTriggers(makeContext({ clis: ["gh"] }), 0)

		expect(events).toEqual([{ name: "gh-cli", trigger: "session", turnIndex: 0 }])
		expect(engine.isLoaded("gh-cli")).toBe(true)
		expect(engine.pendingNames()).toEqual(["gh-cli"])
	})

	it("skips behaviours whose probes do not match", () => {
		const glabCli = makeBehaviour({
			name: "glab-cli",
			kind: "triggered",
			triggers: { session: gitRemote("gitlab.com") },
		})
		const engine = new TriggerEngine([glabCli])
		const events = engine.evaluateSessionTriggers(makeContext({ gitRemoteHost: "github.com" }), 0)

		expect(events).toEqual([])
		expect(engine.isLoaded("glab-cli")).toBe(false)
		expect(engine.pendingNames()).toEqual([])
	})

	it("does not double-load when the same probe matches twice", () => {
		const ghCli = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: { session: cli("gh") },
		})
		const engine = new TriggerEngine([ghCli])
		const ctx = makeContext({ clis: ["gh"] })

		expect(engine.evaluateSessionTriggers(ctx, 0)).toHaveLength(1)
		expect(engine.evaluateSessionTriggers(ctx, 1)).toHaveLength(0)
		expect(engine.loadedNames()).toEqual(["gh-cli"])
	})

	it("ignores baseline behaviours even when they have a session probe", () => {
		const baseline = makeBehaviour({
			name: "git-hygiene",
			kind: "baseline",
			triggers: { session: cli("git") },
		})
		const engine = new TriggerEngine([baseline])
		const events = engine.evaluateSessionTriggers(makeContext({ clis: ["git"] }), 0)

		expect(events).toEqual([])
		expect(engine.isLoaded("git-hygiene")).toBe(false)
	})

	it("loads multiple matching behaviours in registry order", () => {
		const a = makeBehaviour({
			name: "a",
			kind: "triggered",
			triggers: { session: cli("foo") },
		})
		const b = makeBehaviour({
			name: "b",
			kind: "triggered",
			triggers: { session: cli("bar") },
		})
		const engine = new TriggerEngine([a, b])
		const events = engine.evaluateSessionTriggers(makeContext({ clis: ["foo", "bar"] }), 0)

		expect(events.map((e) => e.name)).toEqual(["a", "b"])
		expect(engine.pendingNames()).toEqual(["a", "b"])
	})

	it("skips triggered behaviours without a session probe declared", () => {
		const noTriggers = makeBehaviour({ name: "x", kind: "triggered" })
		const engine = new TriggerEngine([noTriggers])
		expect(engine.evaluateSessionTriggers(makeContext(), 0)).toEqual([])
	})
})

describe("TriggerEngine.takePending", () => {
	it("returns true the first time and false after draining", () => {
		const b = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: { session: cli("gh") },
		})
		const engine = new TriggerEngine([b])
		engine.evaluateSessionTriggers(makeContext({ clis: ["gh"] }), 0)

		expect(engine.takePending("gh-cli")).toBe(true)
		expect(engine.takePending("gh-cli")).toBe(false)
		expect(engine.pendingNames()).toEqual([])
		expect(engine.isLoaded("gh-cli")).toBe(true)
	})

	it("returns false for a name that was never queued", () => {
		const engine = new TriggerEngine([])
		expect(engine.takePending("absent")).toBe(false)
	})
})

describe("TriggerEngine.reset", () => {
	it("clears loaded and pending state", () => {
		const b = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: { session: cli("gh") },
		})
		const engine = new TriggerEngine([b])
		engine.evaluateSessionTriggers(makeContext({ clis: ["gh"] }), 0)
		engine.reset()

		expect(engine.isLoaded("gh-cli")).toBe(false)
		expect(engine.pendingNames()).toEqual([])
	})

	it("allows re-loading a behaviour after reset", () => {
		const b = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: { session: cli("gh") },
		})
		const engine = new TriggerEngine([b])
		const ctx = makeContext({ clis: ["gh"] })
		engine.evaluateSessionTriggers(ctx, 0)
		engine.reset()
		const events = engine.evaluateSessionTriggers(ctx, 1)

		expect(events).toEqual([{ name: "gh-cli", trigger: "session", turnIndex: 1 }])
	})
})
