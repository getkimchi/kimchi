/**
 * Golden-file snapshots of the fully assembled system prompts.
 *
 * These snapshots exist so prompt-surface edits (e.g. removing workflow
 * phases — docs/plans/remove-workflow-phases.md) must be reviewed as diffs:
 * `system-prompt-stability.contract.test.ts` only covers blocks registered
 * via `createSystemPromptBlocks`, and `system-prompt.test.ts` asserts
 * presence/absence — neither shows which content lines actually changed.
 *
 * Covers: (a) a single-model session prompt, (b) a mu lti-model orchestrator
 * prompt with a known role assignment, (c) a subagent prompt for one persona
 * (Builder) with its resolved guidelines block.
 *
 * Determinism: fixed env, fixed tools, `customConfigs: new Map()` so user
 * settings are never read, no `sessionId` so extension blocks stay empty.
 */

import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../models.js"
import { DEFAULT_AGENTS } from "../agents/personas/default-agents.js"
import { AGENT_BUILDER, type EnvInfo } from "../agents/personas/types.js"
import { buildAgentPrompt } from "../agents/prompt/prompts.js"
import { buildRoleGuidelinesSection } from "../orchestration/model-registry/guidelines/guidelines-resolver.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "../orchestration/model-registry/index.js"
import { DEFAULT_MODEL_ROLES } from "../orchestration/model-roles.js"
import { buildSystemPrompt, type EnvironmentInfo } from "./system-prompt.js"

const testEnv: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
	osRelease: "6.1.0-test",
	osVersion: "#1 SMP PREEMPT_DYNAMIC Test",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/projects/myapp",
	documentsDir: "/home/testuser/projects/myapp/.kimchi/docs",
	localDate: "2026-01-01",
	isGitRepo: false,
}

function fakeMetadata(slug: string): ModelMetadata {
	return {
		slug,
		display_name: "",
		provider: "ai-enabler",
		reasoning: false,
		input_modalities: ["text"],
		is_serverless: true,
		limits: { context_window: 131072, max_output_tokens: 16384 },
	}
}

const registry = new ModelRegistry([...MODEL_CAPABILITIES.keys()].map(fakeMetadata))

const tools = [
	{ name: "read", description: "Read file contents" },
	{ name: "bash", description: "Execute bash commands" },
	{ name: "Agent", description: "Launch a specialized agent" },
	{ name: "get_subagent_result", description: "Get background agent result" },
	{ name: "steer_subagent", description: "Steer a running background agent" },
]

describe("system prompt golden snapshots", () => {
	it("single-model session assembles the expected prompt", () => {
		const prompt = buildSystemPrompt({
			tools,
			env: testEnv,
			mode: "single",
			currentModelId: "kimi-k2.7",
			registry,
			customConfigs: new Map(),
		})

		// The section replacing the old Phase Management must be present.
		expect(prompt).toContain("## Working Practices")
		expect(prompt).not.toContain("## Phase Management")
		expect(prompt).not.toContain("set_phase")
		expect(prompt).not.toContain("Do NOT modify files")
		expect(prompt).not.toContain("Do not apply fixes")
		expect(prompt).toMatchSnapshot()
	})

	it("orchestrator session with default role assignments assembles the expected prompt", () => {
		const prompt = buildSystemPrompt({
			tools,
			env: testEnv,
			mode: "orchestrator",
			currentModelId: "kimi-k2.7",
			registry,
			roles: DEFAULT_MODEL_ROLES,
			customConfigs: new Map(),
		})

		expect(prompt).toContain("## Orchestration")
		expect(prompt).toContain("## Working Practices")
		expect(prompt).not.toContain("## Phase Management")
		expect(prompt).not.toContain("set_phase")
		// Orchestrators must not receive build guidance (load-bearing filter).
		expect(prompt).not.toContain("### During build")
		expect(prompt).not.toContain("Read a file before modifying it")
		expect(prompt).toMatchSnapshot()
	})

	it("Builder subagent prompt embeds its resolved build guidelines", () => {
		const builder = DEFAULT_AGENTS.get(AGENT_BUILDER)
		if (!builder) throw new Error("expected default agent 'Builder' to exist")

		const env: EnvInfo = { isGitRepo: true, branch: "main", platform: "linux" }
		const parentPrompt = "You are a kimchi coding agent."
		const guidelinesBlock = buildRoleGuidelinesSection("minimax-m3", "build", registry)
		const prompt = buildAgentPrompt(builder, "/home/testuser/projects/myapp", env, parentPrompt, {
			activeToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			guidelinesBlock,
		})

		expect(prompt).toContain("## Role Guidelines (build)")
		expect(prompt).toMatchSnapshot()
	})
})
