import { describe, expect, it } from "vitest"
import { TriggerEngine } from "./engine.js"
import type { SessionContext } from "./session-context.js"
import { type ToolCallEvent, any, cli, gitRemote, tool } from "./triggers.js"
import type { Behaviour, BehaviourEvals, BehaviourTriggers } from "./types.js"

type MakeArgs =
	| { name: string; kind: "baseline"; description?: string; body?: string }
	| {
			name: string
			kind: "triggered"
			triggers?: BehaviourTriggers
			evals?: BehaviourEvals
			description?: string
			body?: string
	  }

function makeBehaviour(args: MakeArgs): Behaviour {
	const description = args.description ?? `${args.name} behaviour`
	const body = args.body ?? `body of ${args.name}`
	if (args.kind === "baseline") {
		return { kind: "baseline", name: args.name, description, body }
	}
	return {
		kind: "triggered",
		name: args.name,
		description,
		body,
		triggers: args.triggers ?? {},
		evals: args.evals,
	}
}

function makeContext(
	overrides: Partial<{
		clis: Iterable<string>
		gitRemoteHost: string | undefined
		inGitRepo: boolean
		paths: Iterable<string>
	}> = {},
): SessionContext {
	return {
		cliPresent: new Set(overrides.clis ?? []),
		gitRemoteHost: overrides.gitRemoteHost,
		inGitRepo: overrides.inGitRepo ?? false,
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

	it("ignores baseline behaviours", () => {
		const baseline = makeBehaviour({ name: "git-hygiene", kind: "baseline" })
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

	it("skips triggered behaviours whose triggers slot is empty", () => {
		const noTriggers = makeBehaviour({ name: "x", kind: "triggered", triggers: {} })
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

function bashCall(command: string): ToolCallEvent {
	return { toolName: "bash", input: { command } }
}

describe("TriggerEngine.requeueLoaded", () => {
	it("repopulates pending with every loaded behaviour, preserving the loaded set", () => {
		const a = makeBehaviour({ name: "a", kind: "triggered", triggers: { session: cli("foo") } })
		const b = makeBehaviour({ name: "b", kind: "triggered", triggers: { session: cli("bar") } })
		const engine = new TriggerEngine([a, b])
		engine.evaluateSessionTriggers(makeContext({ clis: ["foo", "bar"] }), 0)

		// Drain pending — simulating injector delivery on the first turn.
		expect(engine.takePending("a")).toBe(true)
		expect(engine.takePending("b")).toBe(true)
		expect(engine.pendingNames()).toEqual([])

		const requeued = engine.requeueLoaded()
		expect(requeued).toEqual(["a", "b"])
		expect(engine.pendingNames()).toEqual(["a", "b"])
		expect(engine.loadedNames()).toEqual(["a", "b"])
	})

	it("does nothing when nothing is loaded", () => {
		const engine = new TriggerEngine([])
		expect(engine.requeueLoaded()).toEqual([])
		expect(engine.pendingNames()).toEqual([])
	})

	it("returns names in registry order regardless of load order", () => {
		const a = makeBehaviour({ name: "a", kind: "triggered", triggers: { tool: tool("bash") } })
		const b = makeBehaviour({ name: "b", kind: "triggered", triggers: { tool: tool("bash") } })
		const engine = new TriggerEngine([a, b])
		// Load b first via tool, then a — registry order is still [a, b].
		engine.evaluateToolTriggers(bashCall("ls"), 0)
		expect(engine.requeueLoaded()).toEqual(["a", "b"])
	})

	it("does not re-emit load events when triggers are re-evaluated after requeue", () => {
		const ghCli = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: { session: cli("gh") },
		})
		const engine = new TriggerEngine([ghCli])
		const ctx = makeContext({ clis: ["gh"] })
		expect(engine.evaluateSessionTriggers(ctx, 0)).toHaveLength(1)
		engine.takePending("gh-cli")
		engine.requeueLoaded()
		// A second evaluateSessionTriggers pass must not produce a second load event.
		expect(engine.evaluateSessionTriggers(ctx, 1)).toEqual([])
	})
})

describe("TriggerEngine.loadRecord", () => {
	it("captures session-trigger metadata", () => {
		const ghCli = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: { session: cli("gh") },
		})
		const engine = new TriggerEngine([ghCli])
		engine.evaluateSessionTriggers(makeContext({ clis: ["gh"] }), 4)
		expect(engine.loadRecord("gh-cli")).toEqual({ trigger: "session", turnIndex: 4 })
	})

	it("captures tool-trigger metadata including args", () => {
		const ghCli = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: { tool: tool("bash", (i) => i.command.startsWith("gh ")) },
		})
		const engine = new TriggerEngine([ghCli])
		engine.evaluateToolTriggers(bashCall("gh pr list"), 7)
		expect(engine.loadRecord("gh-cli")).toEqual({
			trigger: "tool",
			turnIndex: 7,
			toolName: "bash",
			toolArgs: { command: "gh pr list" },
		})
	})

	it("returns undefined for behaviours that never loaded", () => {
		const engine = new TriggerEngine([])
		expect(engine.loadRecord("missing")).toBeUndefined()
	})
})

describe("TriggerEngine.evaluateToolTriggers", () => {
	it("loads a triggered behaviour the first time a matching tool call fires", () => {
		const ghCli = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: { tool: tool("bash", (i) => i.command.startsWith("gh ")) },
		})
		const engine = new TriggerEngine([ghCli])
		const events = engine.evaluateToolTriggers(bashCall("gh pr list"), 3)

		expect(events).toEqual([
			{
				name: "gh-cli",
				trigger: "tool",
				turnIndex: 3,
				toolName: "bash",
				toolArgs: { command: "gh pr list" },
			},
		])
		expect(engine.isLoaded("gh-cli")).toBe(true)
		expect(engine.pendingNames()).toEqual(["gh-cli"])
	})

	it("does not re-trigger after the behaviour has loaded", () => {
		const ghCli = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: { tool: tool("bash", (i) => i.command.startsWith("gh ")) },
		})
		const engine = new TriggerEngine([ghCli])
		expect(engine.evaluateToolTriggers(bashCall("gh pr list"), 0)).toHaveLength(1)
		expect(engine.evaluateToolTriggers(bashCall("gh pr view"), 1)).toEqual([])
	})

	it("skips events that do not match the tool matcher", () => {
		const ghCli = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: { tool: tool("bash", (i) => i.command.startsWith("gh ")) },
		})
		const engine = new TriggerEngine([ghCli])
		expect(engine.evaluateToolTriggers(bashCall("ls"), 0)).toEqual([])
		expect(engine.evaluateToolTriggers({ toolName: "read", input: { file_path: "x" } }, 0)).toEqual([])
		expect(engine.isLoaded("gh-cli")).toBe(false)
	})

	it("does not re-load via tool trigger if a session trigger already loaded it", () => {
		const ghCli = makeBehaviour({
			name: "gh-cli",
			kind: "triggered",
			triggers: {
				session: cli("gh"),
				tool: tool("bash", (i) => i.command.startsWith("gh ")),
			},
		})
		const engine = new TriggerEngine([ghCli])
		engine.evaluateSessionTriggers(makeContext({ clis: ["gh"] }), 0)
		expect(engine.evaluateToolTriggers(bashCall("gh pr list"), 1)).toEqual([])
	})

	it("ignores baseline behaviours", () => {
		const baseline = makeBehaviour({ name: "always-on", kind: "baseline" })
		const engine = new TriggerEngine([baseline])
		expect(engine.evaluateToolTriggers(bashCall("anything"), 0)).toEqual([])
		expect(engine.isLoaded("always-on")).toBe(false)
	})

	it("loads multiple matching behaviours in registry order", () => {
		const a = makeBehaviour({
			name: "a",
			kind: "triggered",
			triggers: { tool: tool("bash") },
		})
		const b = makeBehaviour({
			name: "b",
			kind: "triggered",
			triggers: { tool: tool("bash") },
		})
		const engine = new TriggerEngine([a, b])
		const events = engine.evaluateToolTriggers(bashCall("ls"), 0)
		expect(events.map((e) => e.name)).toEqual(["a", "b"])
	})
})
