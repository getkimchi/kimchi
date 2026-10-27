import { describe, expect, it } from "vitest"
import { TriggerEngine } from "./engine.js"
import type { SessionContext } from "./session-context.js"
import { any, cli, gitRemote, lspServes, not, type ToolCallEvent, tool } from "./triggers.js"
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
		lspServes: Iterable<string>
	}> = {},
): SessionContext {
	return {
		cliPresent: new Set(overrides.clis ?? []),
		gitRemoteHost: overrides.gitRemoteHost,
		inGitRepo: overrides.inGitRepo ?? false,
		pathMatches: new Set(overrides.paths ?? []),
		lspServes: new Set(overrides.lspServes ?? []),
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

describe("TriggerEngine.evaluateToolTriggers — gate (probe-as-veto on the tool path)", () => {
	/** The python-edit shape: tool matcher + not(lspServes("py")) gate. */
	function gatedNudge() {
		return makeBehaviour({
			name: "python-edit",
			kind: "triggered",
			triggers: {
				tool: any(
					tool("edit", (i) => i.path.endsWith(".py")),
					tool("write", (i) => i.path.endsWith(".py")),
				),
				gate: not(lspServes("py")),
			},
		})
	}

	const pyEdit = { toolName: "edit", input: { path: "src/main.py" } }

	it("does not load a gated behaviour when the gate fails", () => {
		const engine = new TriggerEngine([gatedNudge()])
		const events = engine.evaluateToolTriggers(pyEdit, 0, makeContext({ lspServes: ["py", "pyw"] }))

		expect(events).toEqual([])
		expect(engine.isLoaded("python-edit")).toBe(false)
		expect(engine.pendingNames()).toEqual([])
	})

	it("loads a gated behaviour when the gate passes", () => {
		const engine = new TriggerEngine([gatedNudge()])
		const events = engine.evaluateToolTriggers(pyEdit, 2, makeContext({}))

		expect(events).toEqual([
			{
				name: "python-edit",
				trigger: "tool",
				turnIndex: 2,
				toolName: "edit",
				toolArgs: { path: "src/main.py" },
			},
		])
		expect(engine.isLoaded("python-edit")).toBe(true)
	})

	it("loads on tool match alone when no gate is declared (back-compat)", () => {
		const b = makeBehaviour({
			name: "ungated",
			kind: "triggered",
			triggers: { tool: tool("bash") },
		})
		const engine = new TriggerEngine([b])
		expect(engine.evaluateToolTriggers(bashCall("ls"), 0, makeContext({ lspServes: ["py"] }))).toHaveLength(1)
		expect(engine.isLoaded("ungated")).toBe(true)
	})

	it("fails open when no session snapshot exists (tool event before session_start)", () => {
		const engine = new TriggerEngine([gatedNudge()])
		// No third argument — the gate is skipped, the nudge still fires.
		expect(engine.evaluateToolTriggers(pyEdit, 0)).toHaveLength(1)
		expect(engine.isLoaded("python-edit")).toBe(true)
	})

	it("keeps checking the gate across repeated tool events (stays unloaded while it fails)", () => {
		const engine = new TriggerEngine([gatedNudge()])
		const ctx = makeContext({ lspServes: ["py"] })
		expect(engine.evaluateToolTriggers(pyEdit, 0, ctx)).toEqual([])
		expect(engine.evaluateToolTriggers(pyEdit, 1, ctx)).toEqual([])
		expect(engine.isLoaded("python-edit")).toBe(false)
	})

	it("ignores the gate on the session-trigger path", () => {
		// A gate that would veto the tool path must not veto a session probe —
		// gate is probe-as-veto for tool loads only, never a load path itself.
		const b = makeBehaviour({
			name: "gated-with-session",
			kind: "triggered",
			triggers: {
				session: cli("gh"),
				tool: tool("bash"),
				gate: not(lspServes("py")),
			},
		})
		const engine = new TriggerEngine([b])
		const events = engine.evaluateSessionTriggers(makeContext({ clis: ["gh"], lspServes: ["py"] }), 0)

		expect(events).toEqual([{ name: "gated-with-session", trigger: "session", turnIndex: 0 }])
		expect(engine.isLoaded("gated-with-session")).toBe(true)
	})

	it("a session-loaded behaviour cannot be re-gated by later tool events", () => {
		const b = makeBehaviour({
			name: "session-then-gated",
			kind: "triggered",
			triggers: {
				session: cli("gh"),
				tool: tool("bash"),
				gate: not(lspServes("py")),
			},
		})
		const engine = new TriggerEngine([b])
		engine.evaluateSessionTriggers(makeContext({ clis: ["gh"] }), 0)
		expect(engine.evaluateToolTriggers(bashCall("ls"), 1, makeContext({ lspServes: ["py"] }))).toEqual([])
		expect(engine.isLoaded("session-then-gated")).toBe(true)
	})
})
