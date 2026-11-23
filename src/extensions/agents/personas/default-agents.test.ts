import { describe, expect, it } from "vitest"
import { buildAgentPrompt } from "../prompt/prompts.js"
import { resolveAgentInvocationConfig } from "../resolution/invocation-config.js"
import { getAgentConfig, registerAgents } from "./agent-types.js"
import { DEFAULT_AGENTS } from "./default-agents.js"
import {
	AGENT_BUILDER,
	AGENT_EXPLORE,
	AGENT_FERMENT_VERIFIER,
	AGENT_GENERAL_PURPOSE,
	AGENT_PLAN,
	AGENT_RESEARCHER,
	type AgentConfig,
} from "./types.js"

describe("DEFAULT_AGENTS", () => {
	it("always includes General-Purpose, Explore, Plan, and Researcher agents", () => {
		expect(DEFAULT_AGENTS.has(AGENT_GENERAL_PURPOSE)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_EXPLORE)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_PLAN)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_RESEARCHER)).toBe(true)
	})

	it("default personas do not declare models", () => {
		for (const agent of DEFAULT_AGENTS.values()) {
			expect(agent.models).toBeUndefined()
		}
	})

	it("all default agents are marked isDefault", () => {
		for (const agent of DEFAULT_AGENTS.values()) {
			expect(agent.isDefault).toBe(true)
		}
	})

	it("Plan agent does not include write or edit in builtinToolNames", () => {
		const plan = DEFAULT_AGENTS.get(AGENT_PLAN) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(plan.builtinToolNames).not.toContain("write")
		expect(plan.builtinToolNames).not.toContain("edit")
	})

	it("Ferment V2 Verifier persona is hidden, write-confined, extension-free and unbounded", () => {
		const verifier = DEFAULT_AGENTS.get(AGENT_FERMENT_VERIFIER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		// write creates probes and baseline test copies; the host guard confines it
		// to new repository files and the disposable baseline worktree.
		expect(verifier.builtinToolNames).toEqual([
			"read",
			"bash",
			"grep",
			"find",
			"ls",
			"write",
			"report_finding",
			"retract_finding",
			"resolve_finding",
			"submit_verdict",
		])
		expect(verifier.disallowedTools).toContain("edit")
		expect(verifier.disallowedTools).not.toContain("write")
		expect(verifier.extensions).toBe(false)
		expect(verifier.skills).toBe(false)
		expect(verifier.thinking).toBe("low")
		// Hidden from the Agent tool and agent UIs without disabling its runtime config.
		expect(verifier.hostOnly).toBe(true)
		expect(verifier.enabled).toBeUndefined()
		// No persona-level caps — the host controls limits per run.
		expect(verifier.maxTurns).toBeUndefined()
		expect(verifier.maxDuration).toBeUndefined()
		expect(verifier.tokenBudget).toBeUndefined()
		expect(verifier.systemPrompt).toContain("<ferment_v2_verifier>")
		expect(verifier.systemPrompt).toContain("[eN]")
	})

	it("Verifier treats the objective as the only authority", () => {
		const prompt = DEFAULT_AGENTS.get(AGENT_FERMENT_VERIFIER)?.systemPrompt
		expect(prompt).toContain("The objective is the only authority")
		expect(prompt).toContain("not the limit of what you attack")
		expect(prompt).toContain("the candidate's output never establishes an expectation")
	})

	it("Verifier chooses distinguishing inputs and distinct failure mechanisms", () => {
		const prompt = DEFAULT_AGENTS.get(AGENT_FERMENT_VERIFIER)?.systemPrompt
		expect(prompt).toContain("expected result, and its source BEFORE executing")
		expect(prompt).toContain("interacting combinations of conditions")
		expect(prompt).toContain("a returned error value, a synchronous throw, a rejected promise")
		expect(prompt).toContain("check a property over generated inputs")
		expect(prompt).toContain("confirm the intended test was discovered, completed, and reached an assertion")
		expect(prompt).toContain("Implementer-authored or modified tests are not independent evidence")
	})

	it("Verifier frames the review as breaking the delivery within the objective", () => {
		const prompt = DEFAULT_AGENTS.get(AGENT_FERMENT_VERIFIER)?.systemPrompt ?? ""
		expect(prompt).toContain("Try to break the delivered work within the boundaries the objective sets")
		expect(prompt).toContain("<defects>")
		expect(prompt).toContain("Do not report: style, naming, structure, or performance")
		expect(prompt).toContain("When your attacks are exhausted without such a failure, the verdict is met.")
		expect(prompt).toContain("2. Attack: before executing, plan the attacks")
	})

	it("Verifier reports findings through tools and keeps observed failures", () => {
		const prompt = DEFAULT_AGENTS.get(AGENT_FERMENT_VERIFIER)?.systemPrompt
		expect(prompt).toContain("report_finding as soon as you observe")
		expect(prompt).toContain("Never retract merely because the candidate disagrees")
		expect(prompt).toContain("presume a regression")
		expect(prompt).toContain("passing checks elsewhere never cancel an observed violation")
		expect(prompt).toContain("Use finalAnswer only when the objective prescribes the text")
	})

	it("delivers each phase persona's guidance through the spawn composition path", () => {
		// The spawn path resolves the phase persona from the unified registry
		// (registerAgents with no user agents = the defaults) and composes the
		// child session's system prompt with buildAgentPrompt — assert the new
		// guidance survives that resolution, not just the raw persona constant.
		registerAgents(new Map())
		const cases = [
			{
				type: AGENT_FERMENT_VERIFIER,
				guidance: [
					"confirm the intended test was discovered, completed, and reached an assertion",
					"every distinct way a dependency can fail",
				],
			},
		] as const
		for (const { type, guidance } of cases) {
			const config = getAgentConfig(type)
			expect(config, `expected persona ${type} to be registered`).toBeDefined()
			const composed = buildAgentPrompt(config as AgentConfig, "/workspace", {
				isGitRepo: true,
				branch: "main",
				platform: "darwin",
			})
			for (const line of guidance) {
				expect(composed).toContain(line)
			}
		}
	})

	it("Plan agent has roles set to plan", () => {
		const plan = DEFAULT_AGENTS.get(AGENT_PLAN) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(plan.roles).toContain("plan")
	})

	it("Plan agent has includeContextFiles set to true", () => {
		const plan = DEFAULT_AGENTS.get(AGENT_PLAN) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(plan.includeContextFiles).toBe(true)
	})

	it("General-Purpose agent has includeContextFiles set to true", () => {
		const gp = DEFAULT_AGENTS.get(AGENT_GENERAL_PURPOSE) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(gp.includeContextFiles).toBe(true)
	})

	it("General-Purpose agent has includeCoreGuidelines set to true", () => {
		const gp = DEFAULT_AGENTS.get(AGENT_GENERAL_PURPOSE) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(gp.includeCoreGuidelines).toBe(true)
	})

	it("General-Purpose agent uses replace prompt mode", () => {
		const gp = DEFAULT_AGENTS.get(AGENT_GENERAL_PURPOSE) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(gp.promptMode).toBe("replace")
	})

	it("Explore agent has roles set to explore", () => {
		const explore = DEFAULT_AGENTS.get(AGENT_EXPLORE) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(explore.roles).toContain("explore")
	})

	it("Explore agent asks for a narrower follow-up when prompts are underspecified", () => {
		const explore = DEFAULT_AGENTS.get(AGENT_EXPLORE) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(explore.systemPrompt).toContain(
			"do one cheap search, read only the most relevant starting points, then stop and ask the orchestrator for a narrower follow-up",
		)
		expect(explore.systemPrompt).toContain("Start from the exact files/directories named by the orchestrator")
		expect(explore.systemPrompt).toContain("Stop when the prompt's stop condition is met")
		expect(explore.systemPrompt).toContain("State where you stopped and why")
		expect(explore.systemPrompt).not.toContain("3-5 most relevant files")
	})

	it("Researcher agent has roles set to research", () => {
		const r = DEFAULT_AGENTS.get(AGENT_RESEARCHER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(r.roles).toContain("research")
	})

	it("Builder prompt instructs trust in provided context and limits verification turns", () => {
		const builder = DEFAULT_AGENTS.get(AGENT_BUILDER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(builder.systemPrompt).toContain(
			"Treat the provided file paths, code snippets, and task description as authoritative",
		)
		expect(builder.systemPrompt).toContain(
			"Do not spend more than **2 consecutive turns** reading or verifying before making the first concrete edit",
		)
		expect(builder.systemPrompt).toContain("Do not re-read files merely to confirm what was provided")
	})
})

describe("default agents — resolved invocation config snapshot", () => {
	const cases: Record<string, string> = {
		"General-Purpose": AGENT_GENERAL_PURPOSE,
		Explore: AGENT_EXPLORE,
		Plan: AGENT_PLAN,
		Researcher: AGENT_RESEARCHER,
	}

	for (const [label, key] of Object.entries(cases)) {
		it(label, () => {
			const agent = DEFAULT_AGENTS.get(key)
			if (!agent) throw new Error(`expected default agent '${label}' to exist`)
			const resolved = resolveAgentInvocationConfig(agent, {})
			expect({
				name: agent.name,
				modelId: resolved.modelInput,
				thinking: resolved.thinking,
				maxTurns: resolved.maxTurns,
				tokenBudget: resolved.tokenBudget,
				roles: agent.roles,
				builtinToolNames: agent.builtinToolNames,
			}).toMatchSnapshot()
		})
	}
})
