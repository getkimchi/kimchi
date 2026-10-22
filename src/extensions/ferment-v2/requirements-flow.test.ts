import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProjectScopeTrusted } from "../../project-scope-trust.js"
import { createCommandContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { clearPermissionModeEnv } from "../permissions/mode-controller.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import { FERMENT_V2_CUSTOM_ENTRY_TYPE, FERMENT_V2_TOOL_NAMES } from "./constants.js"
import { FERMENT_V2_EVENTS } from "./domain-events.js"
import { evaluateFermentV2 } from "./evaluator.js"
import fermentV2Extension from "./index.js"
import { restoreFermentV2 } from "./reducer.js"
import type { VerifierRequirement } from "./requirements.js"
import type { FermentV2RequirementsDraftInput, FermentV2RequirementsDraftOutcome } from "./requirements-agent.js"
import { DEFAULT_FERMENT_V2_SETTINGS, getFermentV2Settings } from "./settings.js"
import type { SessionFermentV2 } from "./types.js"

vi.mock("./settings.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./settings.js")>()
	return { ...actual, getFermentV2Settings: vi.fn() }
})

vi.mock("./evaluator.js", () => ({ evaluateFermentV2: vi.fn() }))
const evaluateMock = vi.mocked(evaluateFermentV2)
const draftMock = vi.hoisted(() =>
	vi.fn<(input: FermentV2RequirementsDraftInput) => Promise<FermentV2RequirementsDraftOutcome>>(),
)
vi.mock("./requirements-agent.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./requirements-agent.js")>()
	return { ...actual, runFermentV2RequirementsDraft: draftMock }
})

const fermentV2SettingsMock = vi.mocked(getFermentV2Settings)

const ITEMS: VerifierRequirement[] = [
	{
		id: "r1",
		requirement: "The greeter returns hello",
		source: "Objective: return hello",
		acceptance: "Output equals hello",
		category: "behavior",
	},
]

function readyOutcome(input: FermentV2RequirementsDraftInput): FermentV2RequirementsDraftOutcome {
	return {
		status: "ready",
		provenance: input.beforeImplementation
			? "pre_implementation"
			: input.baseline
				? "baseline_recovery"
				: "objective_only",
		items: ITEMS,
		usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, costUsd: 0.01 },
		diagnostics: { durationMs: 12, timeoutMs: 120_000, providerRequestCount: 1, model: "test/drafter" },
		objectiveDigest: input.objectiveDigest,
		objectiveRevision: input.revision,
	}
}

function unavailableOutcome(input: FermentV2RequirementsDraftInput, reason: string): FermentV2RequirementsDraftOutcome {
	return {
		status: "unavailable",
		provenance: input.beforeImplementation ? "pre_implementation" : "objective_only",
		unavailableReason: reason,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
		diagnostics: { durationMs: 1, timeoutMs: 120_000, providerRequestCount: 1, failureType: "agent_unavailable" },
		objectiveDigest: input.objectiveDigest,
		objectiveRevision: input.revision,
	}
}

function createHarness() {
	const child = createExtensionApi()
	const branch: SessionEntry[] = []
	child.appendEntry.mockImplementation((customType, data) => {
		branch.push({
			type: "custom",
			customType,
			data,
			id: `e${branch.length}`,
			timestamp: new Date().toISOString(),
			parentId: null,
		})
	})
	vi.mocked(child.api.getActiveTools).mockReturnValue([...FERMENT_V2_TOOL_NAMES, ...TODO_TOOL_NAMES])
	const ctx = createCommandContext()
	ctx.ui.confirm = vi.fn(async () => true)
	ctx.isIdle = () => true
	ctx.sessionManager.getSessionId = () => "session-a"
	ctx.sessionManager.getBranch = () => branch
	ctx.sessionManager.getEntries = () => branch
	fermentV2Extension(child.api)
	const fire = async (event: string, payload: unknown) => {
		await child.emit(event, payload, ctx)
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
	const tool = (name: string, params: Record<string, unknown>) =>
		child.getRegisteredTool(name).execute("call-1", params, new AbortController().signal, undefined, ctx)
	const modelTodoResult = async (todos: Array<{ id: number; content: string; status: string }>) => {
		await fire("tool_execution_end", {
			type: "tool_execution_end",
			toolName: "update_todos",
			isError: false,
			result: {
				details: {
					schemaVersion: 1,
					scope: { kind: "global" },
					todos,
					updatedAt: "2026-08-03T00:00:02.000Z",
				},
			},
		})
	}
	const claim = async () => {
		const result = (await tool("update_ferment_v2", { status: "complete" })) as {
			content: Array<{ text: string }>
		}
		const error = result.content[0]?.text
		if (error?.includes("rejected")) throw new Error(`completion claim failed: ${error}`)
	}
	return {
		pi: child.api,
		ctx,
		ui: ctx.ui,
		appendEntry: child.appendEntry,
		sendMessage: child.sendMessage,
		events: child.api.events,
		branch,
		fire,
		tool,
		modelTodoResult,
		claim,
		command: (args: string) => child.getRegisteredCommand("ferment-v2").handler(args, ctx),
		current(): SessionFermentV2 | undefined {
			return restoreFermentV2(
				branch.flatMap((entry) =>
					entry.type === "custom" && entry.customType === FERMENT_V2_CUSTOM_ENTRY_TYPE ? [entry.data] : [],
				),
			)
		},
	}
}

describe("Ferment V2 requirements lifecycle", () => {
	let cwd: string
	let harness: ReturnType<typeof createHarness>

	beforeEach(() => {
		cwd = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-v2-req-")))
		setProjectScopeTrusted(cwd, true)
		fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS })
		evaluateMock.mockReset().mockResolvedValue({
			verdict: "continue",
			reason: "More work",
			model: "test/verifier",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
			diagnostics: { durationMs: 0, timeoutMs: 0, providerRequestCount: 0, timeoutCount: 0, correctionCount: 0 },
		})
		harness = createHarness()
		harness.ctx.cwd = cwd
	})

	afterEach(async () => {
		await harness.fire("session_shutdown", { type: "session_shutdown" })
		clearPermissionModeEnv("session-a")
		setProjectScopeTrusted(cwd, false)
		vi.restoreAllMocks()
		rmSync(cwd, { recursive: true, force: true })
	})

	it("records accepted requirements before the first implementation request on normal startup", async () => {
		const draftInputs: FermentV2RequirementsDraftInput[] = []
		draftMock.mockImplementation(async (input: FermentV2RequirementsDraftInput) => {
			draftInputs.push(input)
			expect(harness.sendMessage).not.toHaveBeenCalled()
			return readyOutcome(input)
		})

		await harness.command("ship the greeter")

		expect(draftInputs).toHaveLength(1)
		expect(draftInputs[0]).toMatchObject({
			objective: "ship the greeter",
			beforeImplementation: true,
		})
		expect(draftInputs[0]?.objectiveDigest).toMatch(/^[0-9a-f]{64}$/)
		// The contract was applied before the first turn was queued.
		const current = harness.current()
		expect(current?.requirements).toMatchObject({
			availability: "ready",
			contractVersion: 1,
			provenance: "pre_implementation",
			items: ITEMS,
			idWatermark: 1,
			history: [{ version: 1, actor: "requirements_draft", objectiveRevision: 1 }],
		})
		expect(harness.sendMessage).toHaveBeenCalledOnce()
		expect(harness.sendMessage.mock.calls[0]?.[0].details).toMatchObject({ source: "command", revision: 1 })
		expect(harness.events.emit).toHaveBeenCalledWith(
			FERMENT_V2_EVENTS.REQUIREMENTS,
			expect.objectContaining({ availability: "ready", contractVersion: 1, provenance: "pre_implementation" }),
		)
	})

	it("supplies the approved plan text and baseline identity to the draft", async () => {
		const { buildApprovedPlanObjective } = await import("./plan-executor.js")
		const executor = (await import("./plan-executor.js")).getFermentV2PlanExecutor(harness.pi)
		draftMock.mockImplementation(async (input) => readyOutcome(input))
		const planPath = join(cwd, ".kimchi", "plans", "greeter-plan.md")
		mkdirSync(join(cwd, ".kimchi", "plans"), { recursive: true })
		writeFileSync(planPath, "Plan: build the greeter")

		await executor?.(
			{
				objective: buildApprovedPlanObjective(planPath, "Plan: build the greeter"),
				title: "Greeter",
				planText: "Plan: build the greeter",
				planPath,
			},
			harness.ctx,
		)

		const input = draftMock.mock.calls[0]?.[0] as FermentV2RequirementsDraftInput
		expect(input.planText).toContain("Plan: build the greeter")
		expect(input.beforeImplementation).toBe(true)
	})

	it("degrades explicitly and still starts work when the draft fails", async () => {
		draftMock.mockImplementation(async (input) =>
			unavailableOutcome(input, "The drafter subagent system is not available."),
		)

		await harness.command("ship the greeter")

		const current = harness.current()
		expect(current?.requirements).toMatchObject({
			availability: "unavailable",
			provenance: "pre_implementation",
			unavailableReason: "The drafter subagent system is not available.",
			items: [],
		})
		// Work starts anyway: the first implementation turn is queued.
		expect(harness.sendMessage).toHaveBeenCalledOnce()
		expect(harness.events.emit).toHaveBeenCalledWith(
			FERMENT_V2_EVENTS.REQUIREMENTS,
			expect.objectContaining({ availability: "unavailable", reason: "The drafter subagent system is not available." }),
		)
	})

	it("retries an unavailable contract once at the next completion claim, from the baseline or objective only", async () => {
		draftMock.mockImplementation(async (input) =>
			input.beforeImplementation ? unavailableOutcome(input, "outage") : readyOutcome(input),
		)
		await harness.command("ship the greeter")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.modelTodoResult([{ id: 1, content: "Finish the Ferment V2", status: "completed" }])
		await harness.claim()
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })

		expect(draftMock).toHaveBeenCalledTimes(2)
		const retry = draftMock.mock.calls[1]?.[0] as FermentV2RequirementsDraftInput
		expect(retry.beforeImplementation).toBe(false)
		const current = harness.current()
		expect(current?.requirements).toMatchObject({
			availability: "ready",
			contractVersion: 1,
			provenance: "objective_only",
		})
		expect(current?.requirements?.draftRetried).toBe(true)
	})

	it("does not redraft an exhausted degraded contract on a later completion claim after resume", async () => {
		draftMock.mockImplementation(async (input) => unavailableOutcome(input, "outage"))
		evaluateMock.mockResolvedValue({
			verdict: "unavailable",
			reason: "A ready requirements contract is required",
			diagnostics: {
				durationMs: 0,
				timeoutMs: 0,
				providerRequestCount: 0,
				timeoutCount: 0,
				correctionCount: 0,
				failureType: "requirements_unavailable",
			},
		})
		await harness.command("ship the greeter")
		for (const turnIndex of [1, 2]) {
			if (turnIndex === 2) await harness.command("resume")
			await harness.fire("turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() })
			await harness.modelTodoResult([{ id: 1, content: "Finish the Ferment V2", status: "completed" }])
			await harness.claim()
			await harness.fire("agent_end", { type: "agent_end", messages: [] })
			await harness.fire("agent_settled", { type: "agent_settled" })
			expect(harness.current()?.status).toBe("paused")
			expect(draftMock).toHaveBeenCalledTimes(2)
		}
		expect(evaluateMock).toHaveBeenCalledTimes(2)
		for (const [input] of evaluateMock.mock.calls) {
			expect(input.requirements).toBeUndefined()
			expect(input.requirementsUnavailable).toBe("outage")
		}
	})

	it("stale draft results cannot apply", async () => {
		const pending = [] as Array<{
			input: FermentV2RequirementsDraftInput
			resolve: (outcome: FermentV2RequirementsDraftOutcome) => void
		}>
		draftMock.mockImplementation(
			(input) =>
				new Promise<FermentV2RequirementsDraftOutcome>((resolve) => {
					pending.push({ input, resolve: (outcome) => resolve({ ...outcome, objectiveRevision: input.revision }) })
				}),
		)
		const command = harness.command("ship the greeter")
		await vi.waitFor(() => expect(pending).toHaveLength(1))
		expect(harness.sendMessage).not.toHaveBeenCalled()

		// The user edits the objective while the draft runs; the edit aborts the
		// in-flight draft, re-targets the record, and starts a refresh draft —
		// which this test holds until both results are released.
		const editCommand = harness.command("edit revised objective")
		await vi.waitFor(() => expect(pending).toHaveLength(2))
		// The stale startup result (revision 1 digest) resolves late — it must
		// be discarded after its usage settles.
		pending[0]?.resolve(
			readyOutcome({
				fermentV2Id: "x",
				revision: 1,
				objective: "ship the greeter",
				objectiveDigest: pending[0]?.input.objectiveDigest ?? "",
				cwd,
				beforeImplementation: true,
			}),
		)
		pending[1]?.resolve(
			readyOutcome({
				fermentV2Id: "x",
				revision: 2,
				objective: "revised objective",
				objectiveDigest: pending[1]?.input.objectiveDigest ?? "",
				cwd,
				beforeImplementation: false,
			}),
		)
		await command
		await editCommand

		const current = harness.current()
		expect(current?.revision).toBe(2)
		expect(current?.objective).toBe("revised objective")
		expect(current?.requirements).toMatchObject({
			availability: "ready",
			objectiveRevision: 2,
			objectiveText: "revised objective",
			contractVersion: 1,
			history: [{ objectiveRevision: 2 }],
		})
		expect(current?.requirementsUsage?.runs).toBe(2)
	})

	it("objective edits invalidate the old criteria and preserve history", async () => {
		draftMock.mockImplementation(async (input) => readyOutcome(input))
		await harness.command("ship the greeter")
		const before = harness.current()
		expect(before?.requirements?.history).toHaveLength(1)
		// Implementation already started before the edit, so the refresh is
		// recovery-provenance honest.
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })

		await harness.command("edit ship the shout")

		const after = harness.current()
		expect(after?.revision).toBe(2)
		// The old accepted list stays in history; the refresh for the new
		// objective is accepted as version 2.
		expect(after?.requirements?.history).toHaveLength(2)
		expect(after?.requirements).toMatchObject({
			availability: "ready",
			contractVersion: 2,
			objectiveRevision: 2,
			objectiveText: "ship the shout",
		})
		// A refresh draft runs for the new objective; implementation already
		// started, so it is recovery-provenance honest even from the baseline.
		const refresh = draftMock.mock.calls[1]?.[0] as FermentV2RequirementsDraftInput
		expect(refresh.objective).toBe("ship the shout")
		expect(refresh.beforeImplementation).toBe(false)
		expect(after?.requirements?.history[1]).toMatchObject({ version: 2, objectiveRevision: 2 })
	})

	it("settles draft usage exactly once even when the result is discarded as stale", async () => {
		const pending = [] as Array<{
			input: FermentV2RequirementsDraftInput
			resolve: (outcome: FermentV2RequirementsDraftOutcome) => void
		}>
		draftMock.mockImplementation(
			(input) =>
				new Promise<FermentV2RequirementsDraftOutcome>((resolve) => {
					pending.push({ input, resolve: (outcome) => resolve({ ...outcome, objectiveRevision: input.revision }) })
				}),
		)
		const command = harness.command("ship the greeter")
		await vi.waitFor(() => expect(pending).toHaveLength(1))
		const baselineRuns = harness.current()?.requirementsUsage?.runs ?? 0

		const editCommand = harness.command("edit revised objective")
		await vi.waitFor(() => expect(pending).toHaveLength(2))
		// The stale startup result resolves late: its usage still settles even
		// though its list is discarded for the revised objective.
		pending[0]?.resolve(
			readyOutcome({
				fermentV2Id: "x",
				revision: 1,
				objective: "ship the greeter",
				objectiveDigest: "stale",
				cwd,
				beforeImplementation: true,
			}),
		)
		pending[1]?.resolve(
			readyOutcome({
				fermentV2Id: "x",
				revision: 2,
				objective: "revised objective",
				objectiveDigest: pending[1]?.input.objectiveDigest ?? "",
				cwd,
				beforeImplementation: false,
			}),
		)
		await command
		await editCommand

		const current = harness.current()
		expect(current?.requirementsUsage?.runs).toBe(baselineRuns + 2)
		expect(current?.requirements?.availability).toBe("ready")
		expect(current?.requirements?.contractVersion).toBe(1)
	})
	it("recovers an edited contract after refresh outage, preserving old IDs and allocating fresh ones before completion", async () => {
		const added = {
			id: "r2",
			requirement: "Describe hello",
			source: "Objective: describe the result",
			acceptance: "The final answer describes hello",
			category: "delivery" as const,
		}
		draftMock
			.mockImplementationOnce(async (input) => readyOutcome(input))
			.mockImplementationOnce(async (input) => unavailableOutcome(input, "refresh outage"))
			.mockImplementationOnce(async (input) => {
				expect(input.previousContract).toEqual({ items: ITEMS, idWatermark: 1 })
				expect(input.beforeImplementation).toBe(false)
				return { ...readyOutcome(input), items: [...ITEMS, added] }
			})
		await harness.command("return hello")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
		await harness.command("edit return hello and describe the result")
		expect(harness.current()?.requirements).toMatchObject({ availability: "unavailable", idWatermark: 1, items: ITEMS })
		// Settle the old implementation turn superseded by the edit.
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await harness.modelTodoResult([{ id: 1, content: "Return and describe hello", status: "completed" }])
		evaluateMock.mockResolvedValueOnce({
			verdict: "met",
			reason: "Verified",
			model: "test/verifier",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
			diagnostics: { durationMs: 0, timeoutMs: 0, providerRequestCount: 0, timeoutCount: 0, correctionCount: 0 },
		})
		await harness.claim()
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(draftMock).toHaveBeenCalledTimes(3)
		expect(harness.current()?.requirements).toMatchObject({
			availability: "ready",
			contractVersion: 2,
			idWatermark: 2,
			items: [...ITEMS, added],
		})
		expect(harness.current()?.requirements?.history).toHaveLength(2)
		expect(evaluateMock.mock.calls.at(-1)?.[0].requirements?.items).toEqual([...ITEMS, added])
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "The result is hello." }],
			stopReason: "stop",
			usage: { input: 0, output: 0 },
			timestamp: Date.now(),
		}
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 3, timestamp: Date.now() })
		await harness.fire("message_start", { type: "message_start", message })
		await harness.fire("message_end", { type: "message_end", message })
		await harness.fire("turn_end", { type: "turn_end", turnIndex: 3, message })
		await harness.fire("agent_end", { type: "agent_end", messages: [message] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(harness.current()?.status).toBe("complete")
	})
})
