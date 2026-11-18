import { describe, expect, it } from "vitest"
import { buildSkillCommandPrompt } from "../../modes/acp/skill-commands.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createSessionLogHarness } from "../__mocks__/session-log.js"
import directorExtension, { DIRECTOR_TOOL_NAMES } from "./index.js"
import type { DirectorWorkerGateway } from "./lifecycle.js"
import type { DirectorRunState } from "./plan.js"
import { DirectorStore } from "./state.js"

function setup(options: { existingWorkers?: DirectorWorkerGateway["list"]; otherOrchestrationActive?: boolean } = {}) {
	const harness = createSessionLogHarness()
	const workers = [...(options.existingWorkers?.() ?? [])]
	const gateway: DirectorWorkerGateway = {
		list: () => workers,
		abort: (id) => {
			const worker = workers.find((candidate) => candidate.id === id)
			if (!worker) return false
			worker.status = "stopped"
			return true
		},
	}
	const api = createExtensionApi()
	for (const name of [
		"read",
		"grep",
		"bash",
		"edit",
		"Agent",
		"resume_subagent",
		"steer_subagent",
		"get_subagent_result",
		"questionnaire",
		"skill_view",
	]) {
		api.registerTool({ name } as never)
	}
	directorExtension(api.api, {
		createStore: () => harness,
		gateway,
		otherOrchestrationActive: () => options.otherOrchestrationActive ?? false,
		isWorker: () => false,
	})
	const ctx = createContext()
	return { ...api, ctx, harness, gateway, workers }
}

async function input(harness: ReturnType<typeof setup>, text: string, source = "interactive") {
	return harness.getHandler("input")({ type: "input", text, source }, harness.ctx)
}

async function beforeStart(harness: ReturnType<typeof setup>, systemPrompt = "BASE") {
	return (await harness.getHandler("before_agent_start")({ systemPrompt }, harness.ctx)) as
		| { systemPrompt?: string }
		| undefined
}

async function plan(harness: ReturnType<typeof setup>, args: Record<string, unknown>) {
	const tool = harness.getRegisteredTool("director_plan")
	return (await tool.execute("call-plan", args as never, undefined, undefined, harness.ctx as never)) as {
		content: Array<{ text: string }>
		details?: { error?: string; state?: DirectorRunState }
	}
}

async function finish(harness: ReturnType<typeof setup>, args: Record<string, unknown>) {
	const tool = harness.getRegisteredTool("director_finish")
	return (await tool.execute("call-finish", args as never, undefined, undefined, harness.ctx as never)) as {
		content: Array<{ text: string }>
		details?: { error?: string; state?: DirectorRunState }
	}
}

describe("native Director lifecycle", () => {
	it("activates explicitly, shows status, steers without reset, and restores ordinary tools on stop", async () => {
		const harness = setup()
		await harness.getHandler("session_start")({}, harness.ctx)
		expect(harness.getActiveToolNames()).not.toContain("director_plan")

		await input(harness, "/skill:director ship native Director")
		const active = new DirectorStore(harness.harness).read()
		expect(active).toMatchObject({ status: "active", objective: "ship native Director", revision: 1 })
		expect(harness.ctx.ui.setStatus).toHaveBeenCalledWith("director", "Director — ship native Director")
		expect(new Set(harness.getActiveToolNames())).toEqual(new Set(DIRECTOR_TOOL_NAMES))

		await beforeStart(harness)
		await input(harness, "How is progress looking?")
		expect(new DirectorStore(harness.harness).read()?.runId).toBe(active?.runId)
		await harness.getRegisteredCommand("director").handler("status", harness.ctx as never)
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("ship native Director"),
			expect.anything(),
		)

		await harness.getRegisteredCommand("director").handler("stop", harness.ctx as never)
		expect(new DirectorStore(harness.harness).read()?.status).toBe("inactive")
		expect(harness.ctx.ui.setStatus).toHaveBeenCalledWith("director", undefined)
		expect(harness.getActiveToolNames()).toContain("read")
		expect(harness.getActiveToolNames()).not.toContain("director_plan")
	})

	it("preserves live workers through explicit stop --handoff", async () => {
		const harness = setup()
		await harness.getHandler("session_start")({}, harness.ctx)
		await input(harness, "/skill:director handoff command")
		harness.workers.push({
			id: "worker-live",
			type: "Builder",
			description: "Continue independently",
			status: "running",
			startedAt: 1,
		})
		await harness.emitEvent("subagents:started", {
			id: "worker-live",
			type: "Builder",
			description: "Continue independently",
		})

		await harness.getRegisteredCommand("director").handler("stop --handoff", harness.ctx as never)

		const state = new DirectorStore(harness.harness).read()
		expect(state?.status).toBe("inactive")
		expect(state?.plan.workers["worker-live"]).toMatchObject({ disposition: "handed-off", status: "running" })
	})

	it("activates from ACP's rewritten invocation without deriving the objective from the skill body", async () => {
		const harness = setup()
		await harness.getHandler("session_start")({}, harness.ctx)
		await input(
			harness,
			buildSkillCommandPrompt({
				skillName: "director",
				skillContent: "# Activation-only body",
				remainingText: "recover ACP metadata",
			}),
			"rpc",
		)

		expect(new DirectorStore(harness.harness).read()).toMatchObject({
			status: "active",
			objective: "recover ACP metadata",
		})
	})

	it("rejects extension input, other skills, and activation above existing workers", async () => {
		const harness = setup({
			existingWorkers: () => [
				{ id: "ordinary", type: "Builder", description: "Existing task", status: "running", startedAt: 1 },
			],
		})
		await harness.getHandler("session_start")({}, harness.ctx)
		await input(harness, "/skill:director orchestrate this", "extension")
		await input(harness, "/skill:subagents choose workers")
		await input(harness, "/skill:director orchestrate this")

		expect(harness.harness.entries).toHaveLength(0)
		expect(harness.getActiveToolNames()).not.toContain("director_plan")
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ordinary"), "warning")
	})

	it("updates a revision-checked plan and completes with verification", async () => {
		const harness = setup()
		await harness.getHandler("session_start")({}, harness.ctx)
		await input(harness, "/skill:director implement lifecycle")

		const read = await plan(harness, { action: "read" })
		expect(read.details?.state?.revision).toBe(1)
		const updating = await plan(harness, {
			action: "update",
			expectedRevision: 1,
			plan: {
				tasks: [{ id: "done", title: "Runtime", status: "completed", dependsOn: [] }],
				currentPhase: "verify",
				decisions: [],
				contracts: [],
				assumptions: [],
				ownership: [],
				workers: {},
				verification: [],
				openQuestions: [],
				artifactPaths: ["artifacts/verify.txt"],
			},
		})
		expect(updating.details?.state?.revision).toBe(2)

		const result = await finish(harness, {
			outcome: "completed",
			verificationSummary: "Lifecycle suite green",
			artifactPaths: ["artifacts/verify.txt"],
		})
		expect(result.details?.state?.status).toBe("inactive")
		expect(result.content[0]?.text).toContain("Director completed")
	})

	it("tracks workers and blocks new delegation until stale workers are reconciled", async () => {
		const harness = setup()
		await harness.getHandler("session_start")({}, harness.ctx)
		await input(harness, "/skill:director recover stale worker")
		await harness.emitEvent("subagents:started", { id: "stale-1", type: "Builder", description: "Old task" })
		await harness.getHandler("session_start")({}, harness.ctx)

		const state = new DirectorStore(harness.harness).read()
		expect(state?.plan.workers["stale-1"]?.disposition).toBe("uncertain")
		const blocked = await harness.getHandler("tool_call")({ toolName: "Agent" }, harness.ctx)
		expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("stale-1") })

		await plan(harness, { action: "reconcile", workerId: "stale-1", disposition: "stopped", note: "Lost process" })
		const allowed = await harness.getHandler("tool_call")({ toolName: "Agent" }, harness.ctx)
		expect(allowed).toBeUndefined()
	})

	it("persists every Director-owned worker lifecycle transition", async () => {
		const harness = setup()
		await harness.getHandler("session_start")({}, harness.ctx)
		await input(harness, "/skill:director observe a worker")
		await harness.emitEvent("subagents:started", { id: "worker-1", type: "Builder", description: "Observe" })
		await harness.emitEvent("subagents:compacted", { id: "worker-1", compactionCount: 2 })
		await harness.emitEvent("subagents:backgrounded", { id: "worker-1" })
		let state = new DirectorStore(harness.harness).read()
		expect(state?.plan.workers["worker-1"]).toMatchObject({
			status: "running",
			disposition: "owned",
			compactionCount: 2,
			backgrounded: true,
		})

		await harness.emitEvent("subagents:completed", { id: "worker-1", status: "completed", result: "done" })
		await harness.emitEvent("subagents:started", {
			id: "worker-1",
			type: "Builder",
			description: "Continue observation",
		})
		state = new DirectorStore(harness.harness).read()
		expect(state?.plan.workers["worker-1"]).toMatchObject({ status: "running", disposition: "owned" })
	})
})
