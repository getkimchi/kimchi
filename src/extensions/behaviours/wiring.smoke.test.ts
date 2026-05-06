/**
 * Integration smoke test for `wireBehaviours`. The unit tests for
 * `TriggerEngine`, `EvalEngine`, and `resolveSessionContext` cover state
 * transitions and matching logic. This file verifies the wiring layer:
 * which `pi.on(...)` handlers fire, what they append to the JSONL, and what
 * shape they return to the agent runner — without re-testing engine logic.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { describe, expect, it } from "vitest"
import type { ResolverIO } from "./session-context.js"
import {
	BEHAVIOUR_EVAL_TYPE,
	BEHAVIOUR_LOADED_TYPE,
	BEHAVIOUR_REQUEUED_TYPE,
	BEHAVIOUR_SESSION_SUMMARY_TYPE,
} from "./stats.js"
import { cli, tool } from "./triggers.js"
import type { Behaviour } from "./types.js"
import { BEHAVIOUR_BODY_TYPE, wireBehaviours } from "./wiring.js"

type Handler = (event: unknown, ctx?: unknown) => unknown

interface Appended {
	type: string
	data: unknown
}

interface Sent {
	message: { customType: string; content: string; display: boolean; details?: unknown }
	options?: { deliverAs?: string; triggerTurn?: boolean }
}

class FakePi {
	readonly handlers = new Map<string, Handler[]>()
	readonly appended: Appended[] = []
	readonly sent: Sent[] = []

	asExtensionAPI(): ExtensionAPI {
		return this as unknown as ExtensionAPI
	}

	on(event: string, handler: Handler): void {
		const list = this.handlers.get(event) ?? []
		list.push(handler)
		this.handlers.set(event, list)
	}

	appendEntry(type: string, data?: unknown): void {
		this.appended.push({ type, data })
	}

	sendMessage(message: Sent["message"], options?: Sent["options"]): void {
		this.sent.push({ message, options })
	}

	async fire<R = unknown>(event: string, payload: unknown, ctx: unknown = {}): Promise<R[]> {
		const list = this.handlers.get(event) ?? []
		const out: R[] = []
		for (const h of list) {
			const r = await h(payload, ctx)
			if (r !== undefined) out.push(r as R)
		}
		return out
	}

	entries(type: string): Appended[] {
		return this.appended.filter((e) => e.type === type)
	}
}

const stubIO: ResolverIO = {
	hasCli: (name) => name === "gh",
	readGitRemoteHost: () => undefined,
	isGitRepo: () => false,
	walkPaths: () => new Set<string>(),
}

const baseline: Behaviour = {
	kind: "baseline",
	name: "rule-1",
	description: "always-on rule",
	body: "Always do X.",
}

const ghCli: Behaviour = {
	kind: "triggered",
	name: "gh-cli",
	description: "gh CLI guidance",
	body: "Use gh for GitHub.",
	triggers: { session: cli("gh") },
	evals: {
		observed: tool("bash", (i) => i.command.startsWith("gh ")),
		violated: tool("bash", (i) => i.command.startsWith("curl ")),
	},
}

const glabCli: Behaviour = {
	kind: "triggered",
	name: "glab-cli",
	description: "glab CLI guidance",
	body: "Use glab for GitLab.",
	triggers: { tool: tool("bash", (i) => i.command.startsWith("glab ")) },
}

function setupWired(behaviours: Behaviour[]): FakePi {
	const pi = new FakePi()
	wireBehaviours(pi.asExtensionAPI(), behaviours, { resolverIO: stubIO })
	return pi
}

describe("wireBehaviours — session_start", () => {
	it("appends behaviour_loaded for a session-triggered behaviour", async () => {
		const pi = setupWired([ghCli])
		await pi.fire("session_start", {}, { cwd: "/tmp" })

		expect(pi.entries(BEHAVIOUR_LOADED_TYPE)).toEqual([
			{ type: BEHAVIOUR_LOADED_TYPE, data: { name: "gh-cli", trigger: "session", turnIndex: 0 } },
		])
	})

	it("does not append when no session probe matches", async () => {
		const pi = setupWired([glabCli])
		await pi.fire("session_start", {}, { cwd: "/tmp" })

		expect(pi.entries(BEHAVIOUR_LOADED_TYPE)).toEqual([])
	})

	it("re-fires cleanly: a second session_start drops stale state", async () => {
		const pi = setupWired([ghCli])
		await pi.fire("session_start", {}, { cwd: "/tmp" })
		await pi.fire("session_start", {}, { cwd: "/tmp" })

		// Two loads (one per session_start), not one duplicated row from the same session.
		expect(pi.entries(BEHAVIOUR_LOADED_TYPE)).toHaveLength(2)
	})
})

describe("wireBehaviours — tool_call", () => {
	it("appends behaviour_loaded when a tool trigger fires", async () => {
		const pi = setupWired([glabCli])
		await pi.fire("session_start", {}, { cwd: "/tmp" })
		await pi.fire("turn_start", { turnIndex: 3 })
		await pi.fire("tool_call", { toolName: "bash", input: { command: "glab mr list" } })

		expect(pi.entries(BEHAVIOUR_LOADED_TYPE)).toEqual([
			{
				type: BEHAVIOUR_LOADED_TYPE,
				data: {
					name: "glab-cli",
					trigger: "tool",
					turnIndex: 3,
					toolArgs: { command: "glab mr list" },
				},
			},
		])
	})

	it("appends behaviour_eval for loaded behaviours but not on the call that loaded them", async () => {
		const pi = setupWired([ghCli])
		await pi.fire("session_start", {}, { cwd: "/tmp" })
		await pi.fire("turn_start", { turnIndex: 1 })
		await pi.fire("tool_call", { toolName: "bash", input: { command: "gh pr list" } })
		await pi.fire("tool_call", { toolName: "bash", input: { command: "curl https://x" } })

		const evals = pi.entries(BEHAVIOUR_EVAL_TYPE).map((e) => (e.data as { verdict: string }).verdict)
		expect(evals).toEqual(["observed", "violated"])
	})

	it("does not score evals before the behaviour loads", async () => {
		const pi = setupWired([glabCli])
		// session_start does NOT load glab-cli (no session probe). The first
		// matching tool_call loads it; that same call must not score evals.
		await pi.fire("session_start", {}, { cwd: "/tmp" })
		await pi.fire("tool_call", { toolName: "bash", input: { command: "glab mr list" } })

		expect(pi.entries(BEHAVIOUR_EVAL_TYPE)).toEqual([])
	})
})

describe("wireBehaviours — tool_result", () => {
	it("steers a tool-triggered body in the same turn as the trigger", async () => {
		const pi = setupWired([glabCli])
		await pi.fire("session_start", {}, { cwd: "/tmp" })
		await pi.fire("turn_start", { turnIndex: 1 })
		await pi.fire("tool_call", { toolName: "bash", input: { command: "glab mr list" } })
		await pi.fire("tool_result", { toolName: "bash", input: { command: "glab mr list" } })

		expect(pi.sent).toEqual([
			{
				message: expect.objectContaining({
					customType: BEHAVIOUR_BODY_TYPE,
					content: "Use glab for GitLab.",
					display: false,
				}),
				options: { deliverAs: "steer" },
			},
		])

		// Pending drained: a later before_agent_start does NOT re-deliver the body.
		const next = await pi.fire<{ message?: unknown }>("before_agent_start", { prompt: "x", systemPrompt: "BASE" })
		expect(next.flatMap((r) => (r.message ? [r.message] : []))).toEqual([])
	})

	it("does not steer for session-triggered bodies (already drained by before_agent_start)", async () => {
		const pi = setupWired([ghCli])
		await pi.fire("session_start", {}, { cwd: "/tmp" })
		await pi.fire("before_agent_start", { prompt: "x", systemPrompt: "BASE" })
		await pi.fire("tool_result", { toolName: "bash", input: { command: "gh pr list" } })

		expect(pi.sent).toEqual([])
	})
})

describe("wireBehaviours — before_agent_start", () => {
	it("appends the rules block for baseline behaviours to the system prompt", async () => {
		const pi = setupWired([baseline])
		await pi.fire("session_start", {}, { cwd: "/tmp" })
		const results = await pi.fire<{ systemPrompt?: string }>("before_agent_start", {
			prompt: "hi",
			systemPrompt: "BASE",
		})

		const sp = results.find((r) => r.systemPrompt !== undefined)?.systemPrompt
		expect(sp).toContain("## Rules")
		expect(sp).toContain("Always do X.")
		expect(sp?.startsWith("BASE")).toBe(true)
	})

	it("delivers the body of a loaded triggered behaviour as a hidden message, exactly once", async () => {
		const pi = setupWired([ghCli])
		await pi.fire("session_start", {}, { cwd: "/tmp" })

		const first = await pi.fire<{ message?: { customType: string; content: string; display: boolean } }>(
			"before_agent_start",
			{ prompt: "hi", systemPrompt: "BASE" },
		)
		const messages = first.flatMap((r) => (r.message ? [r.message] : []))
		expect(messages).toEqual([
			expect.objectContaining({
				customType: BEHAVIOUR_BODY_TYPE,
				content: "Use gh for GitHub.",
				display: false,
			}),
		])

		// Second turn — body already drained, no message returned.
		const second = await pi.fire<{ message?: unknown }>("before_agent_start", { prompt: "hi", systemPrompt: "BASE" })
		expect(second.flatMap((r) => (r.message ? [r.message] : []))).toEqual([])
	})
})

describe("wireBehaviours — session_compact", () => {
	it("appends behaviour_requeued for each loaded behaviour and re-delivers the body", async () => {
		const pi = setupWired([ghCli])
		await pi.fire("session_start", {}, { cwd: "/tmp" })
		await pi.fire("turn_start", { turnIndex: 5 })
		// Drain initial pending.
		await pi.fire("before_agent_start", { prompt: "hi", systemPrompt: "BASE" })

		await pi.fire("session_compact", {})
		expect(pi.entries(BEHAVIOUR_REQUEUED_TYPE)).toEqual([
			{ type: BEHAVIOUR_REQUEUED_TYPE, data: { name: "gh-cli", turnIndex: 5 } },
		])

		// Body re-delivered on next agent start.
		const post = await pi.fire<{ message?: unknown }>("before_agent_start", { prompt: "hi", systemPrompt: "BASE" })
		expect(post.flatMap((r) => (r.message ? [r.message] : []))).toHaveLength(1)
	})
})

describe("wireBehaviours — session_shutdown", () => {
	it("emits a session summary covering baseline + loaded behaviours", async () => {
		const pi = setupWired([baseline, ghCli, glabCli])
		await pi.fire("session_start", {}, { cwd: "/tmp" })
		await pi.fire("turn_start", { turnIndex: 2 })
		await pi.fire("tool_call", { toolName: "bash", input: { command: "gh pr list" } })
		await pi.fire("session_shutdown", {})

		const summary = pi.entries(BEHAVIOUR_SESSION_SUMMARY_TYPE)
		expect(summary).toHaveLength(1)
		const entries = (summary[0].data as { behaviours: Array<{ name: string; loaded: boolean; observed: number }> })
			.behaviours
		// glab-cli never loaded, so it's omitted by design.
		expect(entries.map((e) => e.name)).toEqual(["rule-1", "gh-cli"])
		expect(entries.find((e) => e.name === "gh-cli")?.observed).toBe(1)
	})

	it("is idempotent across repeated session_shutdown firings", async () => {
		const pi = setupWired([baseline])
		await pi.fire("session_start", {}, { cwd: "/tmp" })
		await pi.fire("session_shutdown", {})
		await pi.fire("session_shutdown", {})

		expect(pi.entries(BEHAVIOUR_SESSION_SUMMARY_TYPE)).toHaveLength(1)
	})
})
