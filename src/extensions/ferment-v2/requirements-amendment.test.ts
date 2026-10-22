/**
 * requirements-amendment.test.ts — the evidence-backed requirements amendment
 * flow: host validation/diffing, the read-only evaluator ruling, atomic
 * application, rejected-proposal caching, and the completion-claim fencing
 * that keeps evaluation from running against criteria a claim never observed.
 *
 * Deterministic fixtures here prove orchestration and enforcement only —
 * never that the ruling model's judgment is correct.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs"
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
import type {
	FermentV2RequirementsAmendmentInput,
	FermentV2RequirementsAmendmentOutcome,
	FermentV2RequirementsDraftInput,
	FermentV2RequirementsDraftOutcome,
} from "./requirements-agent.js"
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
const rulingMock = vi.hoisted(() =>
	vi.fn<(input: FermentV2RequirementsAmendmentInput) => Promise<FermentV2RequirementsAmendmentOutcome>>(),
)
vi.mock("./requirements-agent.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./requirements-agent.js")>()
	return {
		...actual,
		runFermentV2RequirementsDraft: draftMock,
		runFermentV2RequirementsAmendmentRuling: rulingMock,
	}
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
const ADDED: VerifierRequirement = {
	id: "r2",
	requirement: "The greeter supports names",
	source: "Objective: greet by name",
	acceptance: "Greeting by name uses the supplied name",
	category: "behavior",
}

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 }
const ZERO_DIAGNOSTICS = { durationMs: 0, timeoutMs: 120_000, providerRequestCount: 0 }

function acceptedOutcome(input: FermentV2RequirementsAmendmentInput): FermentV2RequirementsAmendmentOutcome {
	return {
		status: "accepted",
		reason: "The objective's greeting clause explicitly names the input form.",
		usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, costUsd: 0.01 },
		diagnostics: { ...ZERO_DIAGNOSTICS, durationMs: 10, providerRequestCount: 1, model: "test/ruler" },
		objectiveDigest: input.objectiveDigest,
		objectiveRevision: input.revision,
	}
}

function rejectedOutcome(
	input: FermentV2RequirementsAmendmentInput,
	reason: string,
): FermentV2RequirementsAmendmentOutcome {
	return {
		status: "rejected",
		reason,
		usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5, costUsd: 0.01 },
		diagnostics: { ...ZERO_DIAGNOSTICS, durationMs: 10, providerRequestCount: 1, model: "test/ruler" },
		objectiveDigest: input.objectiveDigest,
		objectiveRevision: input.revision,
	}
}

function unavailableOutcome(
	input: FermentV2RequirementsAmendmentInput,
	reason: string,
): FermentV2RequirementsAmendmentOutcome {
	return {
		status: "unavailable",
		reason,
		usage: EMPTY_USAGE,
		diagnostics: { ...ZERO_DIAGNOSTICS, durationMs: 1, providerRequestCount: 1, failureType: "agent_unavailable" },
		objectiveDigest: input.objectiveDigest,
		objectiveRevision: input.revision,
	}
}

function draftReadyOutcome(input: FermentV2RequirementsDraftInput): FermentV2RequirementsDraftOutcome {
	return {
		status: "ready",
		provenance: "pre_implementation",
		items: ITEMS,
		usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, costUsd: 0.01 },
		diagnostics: { durationMs: 12, timeoutMs: 120_000, providerRequestCount: 1, model: "test/drafter" },
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
	const tool = (name: string, params: Record<string, unknown>, signal = new AbortController().signal) =>
		child.getRegisteredTool(name).execute("call-1", params, signal, undefined, ctx)
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
	return {
		pi: child.api,
		ctx,
		ui: ctx.ui,
		sendMessage: child.sendMessage,
		events: child.api.events,
		branch,
		fire,
		tool,
		modelTodoResult,
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

describe("Ferment V2 requirements amendments", () => {
	let cwd: string
	let harness: ReturnType<typeof createHarness>

	beforeEach(() => {
		cwd = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-v2-amend-")))
		setProjectScopeTrusted(cwd, true)
		fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS })
		draftMock.mockReset().mockImplementation(async (input) => draftReadyOutcome(input))
		rulingMock.mockReset().mockImplementation(async () => {
			throw new Error("rulingMock not configured for this test; the proposal should not have reached a ruling")
		})
		evaluateMock.mockReset().mockResolvedValue({
			verdict: "continue",
			reason: "More work",
			model: "test/verifier",
			usage: EMPTY_USAGE,
			diagnostics: { ...ZERO_DIAGNOSTICS, timeoutCount: 0, correctionCount: 0 },
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

	async function startGoal() {
		await harness.command("ship the greeter")
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() })
	}

	const amend = (params: Record<string, unknown>) =>
		harness.tool("amend_ferment_v2_requirements", { expectedVersion: 1, ...params })

	const text = (result: unknown) => {
		const content = (result as { content?: ReadonlyArray<{ text?: unknown }> }).content
		return typeof content?.[0]?.text === "string" ? content[0].text : ""
	}

	it("applies an accepted amendment atomically: version bump, history, and next-turn criteria", async () => {
		await startGoal()
		rulingMock.mockImplementation(async (input) => {
			expect(input.currentItems).toEqual(ITEMS)
			expect(input.proposedItems).toEqual([...ITEMS, ADDED])
			expect(input.reason).toContain("greet by name")
			return acceptedOutcome(input)
		})
		const result = await amend({
			requirements: [...ITEMS, ADDED],
			reason: "The objective's greeting clause says greet by name; the list misses it.",
		})
		expect(text(result)).toContain("Amendment accepted")
		expect(text(result)).toContain("version 2")
		const current = harness.current()
		expect(current?.requirements).toMatchObject({
			availability: "ready",
			contractVersion: 2,
			idWatermark: 2,
			items: [...ITEMS, ADDED],
		})
		expect(current?.requirements?.history[1]).toMatchObject({
			version: 2,
			actor: "requirements_amendment",
			objectiveRevision: 1,
		})
		expect(current?.revision).toBe(1)
		expect(current?.amendmentsUsage).toMatchObject({ runs: 1, totalTokens: 7 })
		expect(harness.events.emit).toHaveBeenCalledWith(
			FERMENT_V2_EVENTS.REQUIREMENTS,
			expect.objectContaining({ availability: "ready", contractVersion: 2 }),
		)
		// The ruling runs read-only in the workspace: no shell/write tools reach it
		// (host guard), and the fixture input proves it saw the current contract.
	})

	it("preserves all current obligations on a rejection and leaves the goal active", async () => {
		await startGoal()
		rulingMock.mockImplementation(async (input) =>
			rejectedOutcome(input, "Implementation difficulty never weakens a sourced obligation."),
		)
		const result = await amend({
			requirements: [ITEMS[0], { ...ITEMS[0], id: "r2", requirement: "narrowed" }],
			reason: "Narrowing is easier.",
		})
		expect(text(result)).toContain("Amendment rejected")
		expect(text(result)).toContain("Implementation difficulty")
		const current = harness.current()
		expect(current?.requirements).toMatchObject({ availability: "ready", contractVersion: 1, items: ITEMS })
		expect(current?.status).toBe("active")
		expect(current?.requirements?.rejectedProposals).toHaveLength(1)
	})

	it("answers an exact repeated rejected proposal from the cache without a second ruling", async () => {
		await startGoal()
		rulingMock.mockImplementation(async (input) =>
			rejectedOutcome(input, "No source weakens the acceptance condition."),
		)
		const proposal = {
			requirements: [ITEMS[0], { ...ITEMS[0], id: "r2", requirement: "narrowed" }],
			reason: "Narrowing is easier.",
		}
		await amend(proposal)
		const cached = await amend(proposal)
		expect(text(cached)).toContain("cached ruling")
		expect(text(cached)).toContain("No source weakens")
		expect(rulingMock).toHaveBeenCalledTimes(1)
		// Changed evidence permits reconsideration: a new ruling runs.
		const changed = await amend({ ...proposal, reason: "New evidence: the objective supersedes it." })
		expect(text(changed)).not.toContain("cached ruling")
		expect(rulingMock).toHaveBeenCalledTimes(2)
		// A changed contract version also permits reconsideration.
		rulingMock.mockImplementation(async (input) => acceptedOutcome(input))
		await amend({
			requirements: [...ITEMS, ADDED],
			reason: "The objective requires names.",
		})
		expect(rulingMock).toHaveBeenCalledTimes(3)
	})

	it("returns the current version for a no-op proposal without a model call", async () => {
		await startGoal()
		const result = await amend({ requirements: ITEMS, reason: "Reordering only." })
		expect(text(result)).toContain("no-op")
		expect(text(result)).toContain("version 1")
		expect(rulingMock).not.toHaveBeenCalled()
	})

	it("rejects stale versions, retired-ID reuse, and remove-all proposals without a model call", async () => {
		// A contract that previously allocated r2–r4 (retired) plus current r1/r5.
		draftMock.mockImplementation(async (input) => ({
			...draftReadyOutcome(input),
			items: [ITEMS[0], { ...ITEMS[0], id: "r5", requirement: "The greeter logs each greeting" }],
		}))
		await startGoal()
		const stale = await amend({
			requirements: [...ITEMS, ADDED],
			reason: "The objective requires names.",
			expectedVersion: 7,
		})
		expect(text(stale)).toContain("version 7")
		expect(text(stale)).toContain("current contract version is 1")
		const retired = await amend({
			requirements: [
				ITEMS[0],
				{ ...ITEMS[0], id: "r5", requirement: "The greeter logs each greeting" },
				{ ...ITEMS[0], id: "r2", requirement: "reusing a retired ID" },
			],
			reason: "The objective still implies it.",
		})
		expect(text(retired)).toContain("retired requirement ID cannot be reused")
		const removeAll = await amend({
			requirements: [{ ...ITEMS[0], id: "r6", requirement: "total replacement" }],
			reason: "Rebuilding from scratch.",
		})
		expect(text(removeAll)).toContain("at least one current obligation")
		expect(rulingMock).not.toHaveBeenCalled()
		const current = harness.current()
		expect(current?.requirements).toMatchObject({ contractVersion: 1, idWatermark: 5 })
	})

	it("leaves work active with an explicit reason when the ruling is unavailable", async () => {
		await startGoal()
		rulingMock.mockImplementation(async (input) =>
			unavailableOutcome(input, "The ruler subagent system is not available."),
		)
		const result = await amend({
			requirements: [...ITEMS, ADDED],
			reason: "The objective requires names.",
		})
		expect(text(result)).toContain("Amendment ruling unavailable")
		const current = harness.current()
		expect(current?.requirements).toMatchObject({ availability: "ready", contractVersion: 1, items: ITEMS })
		expect(current?.status).toBe("active")
		// Unavailable rulings are not cached: a retry may spend the ruling.
		expect(current?.requirements?.rejectedProposals ?? []).toHaveLength(0)
		await amend({ requirements: [...ITEMS, ADDED], reason: "The objective requires names." })
		expect(rulingMock).toHaveBeenCalledTimes(2)
	})

	it("discards a ruling that settles against a moved contract and reports the new version", async () => {
		await startGoal()
		let release: ((outcome: FermentV2RequirementsAmendmentOutcome) => void) | undefined
		rulingMock.mockImplementation(
			(input) =>
				new Promise<FermentV2RequirementsAmendmentOutcome>((resolve) => {
					release = (outcome) => resolve({ ...outcome, objectiveRevision: input.revision })
				}),
		)
		const pending = amend({
			requirements: [...ITEMS, ADDED],
			reason: "The objective requires names.",
		})
		await vi.waitFor(() => expect(release).toBeDefined())
		// An objective edit bumps the revision while the ruling is in flight.
		await harness.command("edit ship a farewell bot")
		release?.(
			acceptedOutcome({
				fermentV2Id: "x",
				revision: 1,
				objective: "ship the greeter",
				objectiveDigest: "a".repeat(64),
				contractVersion: 1,
				currentItems: ITEMS,
				proposedItems: [...ITEMS, ADDED],
				diff: { added: [ADDED], changed: [], removed: [] },
				reason: "evidence",
				cwd,
			}),
		)
		const result = await pending
		expect(text(result)).toContain("contract moved while the ruling ran")
		// Usage still settles exactly once against the surviving ferment.
		expect(harness.current()?.amendmentsUsage).toMatchObject({ runs: 1 })
	})

	it("forwards tool-call cancellation to the ruling and never applies an accepted result afterwards", async () => {
		await startGoal()
		let release: ((outcome: FermentV2RequirementsAmendmentOutcome) => void) | undefined
		let observedSignal: AbortSignal | undefined
		rulingMock.mockImplementation(async (input) => {
			observedSignal = input.signal
			return new Promise<FermentV2RequirementsAmendmentOutcome>((resolve) => {
				release = (outcome) => resolve({ ...outcome, objectiveRevision: input.revision })
			})
		})
		const controller = new AbortController()
		const pending = harness.tool(
			"amend_ferment_v2_requirements",
			{ expectedVersion: 1, requirements: [...ITEMS, ADDED], reason: "The objective requires names." },
			controller.signal,
		)
		await vi.waitFor(() => expect(release).toBeDefined())
		// Cancelling the turn aborts the tool call's signal — the combined signal
		// the ruling received is aborted too.
		controller.abort()
		expect(observedSignal?.aborted).toBe(true)
		// The ruling resolves accepted anyway (the race the recheck defends): it
		// must still not be applied.
		release?.(
			acceptedOutcome({
				fermentV2Id: "x",
				revision: 1,
				objective: "ship the greeter",
				objectiveDigest: "a".repeat(64),
				contractVersion: 1,
				currentItems: ITEMS,
				proposedItems: [...ITEMS, ADDED],
				diff: { added: [ADDED], changed: [], removed: [] },
				reason: "evidence",
				cwd,
			}),
		)
		const result = await pending
		expect(text(result)).toContain("Amendment ruling cancelled")
		const current = harness.current()
		// The contract stands untouched: no version bump, no history entry, no
		// rejection-cache entry — but the ruling's usage still settled once.
		expect(current?.requirements).toMatchObject({ availability: "ready", contractVersion: 1, items: ITEMS })
		expect(current?.requirements?.history).toHaveLength(1)
		expect(current?.requirements?.rejectedProposals ?? []).toHaveLength(0)
		expect(current?.amendmentsUsage).toMatchObject({ runs: 1, totalTokens: 7 })
		expect(current?.status).toBe("active")
	})

	it("refuses a same-turn completion claim after an accepted amendment and accepts a fresh claim", async () => {
		await startGoal()
		await harness.modelTodoResult([{ id: 1, content: "Greet", status: "completed" }])
		rulingMock.mockImplementation(async (input) => acceptedOutcome(input))
		await amend({
			requirements: [...ITEMS, ADDED],
			reason: "The objective requires names.",
		})
		const refused = await harness.tool("update_ferment_v2", { status: "complete" })
		expect(text(refused)).toContain("requirements contract was amended this turn")
		expect(text(refused)).toContain("version 2")
		expect(harness.current()?.status).toBe("active")
		// A new turn clears the fence: the implementer has seen the criteria.
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await harness.modelTodoResult([{ id: 1, content: "Greet", status: "completed" }])
		const claimed = await harness.tool("update_ferment_v2", { status: "complete" })
		expect(text(claimed)).toContain("Recorded")
	})

	it("does not evaluate a claim whose captured contract version moved", async () => {
		await startGoal()
		evaluateMock.mockResolvedValue({
			verdict: "met",
			reason: "Verified",
			model: "test/verifier",
			usage: EMPTY_USAGE,
			diagnostics: { ...ZERO_DIAGNOSTICS, timeoutCount: 0, correctionCount: 0 },
		})
		// Claim against version 1.
		await harness.modelTodoResult([{ id: 1, content: "Greet", status: "completed" }])
		const claimed = await harness.tool("update_ferment_v2", { status: "complete" })
		expect(text(claimed)).toContain("Recorded")
		// The amendment settles in the same turn window (accepted): the claim is gone.
		rulingMock.mockImplementation(async (input) => acceptedOutcome(input))
		const amendResult = await amend({
			requirements: [...ITEMS, ADDED],
			reason: "The objective requires names.",
		})
		expect(text(amendResult)).toContain("Amendment accepted")
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		// No evaluation ran against criteria the claim never observed.
		expect(evaluateMock).not.toHaveBeenCalled()
		expect(harness.current()?.status).toBe("active")
		// A fresh claim against version 2 evaluates normally.
		await harness.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() })
		await harness.modelTodoResult([{ id: 1, content: "Greet", status: "completed" }])
		await harness.tool("update_ferment_v2", { status: "complete" })
		await harness.fire("agent_end", { type: "agent_end", messages: [] })
		await harness.fire("agent_settled", { type: "agent_settled" })
		expect(evaluateMock).toHaveBeenCalledTimes(1)
		expect(evaluateMock.mock.calls[0]?.[0].requirements?.items).toEqual([...ITEMS, ADDED])
	})

	it("is not available without a current ready contract and reports the degraded state", async () => {
		// A draft outage leaves the record unavailable: amendments need a ready
		// contract, and work continues against the objective meanwhile.
		draftMock.mockImplementation(async (input) => ({
			status: "unavailable" as const,
			provenance: "pre_implementation" as const,
			unavailableReason: "draft outage",
			usage: EMPTY_USAGE,
			diagnostics: {
				...ZERO_DIAGNOSTICS,
				durationMs: 1,
				providerRequestCount: 1,
				failureType: "agent_unavailable" as const,
			},
			objectiveDigest: input.objectiveDigest,
			objectiveRevision: input.revision,
		}))
		await startGoal()
		const noContract = await amend({
			requirements: [...ITEMS, ADDED],
			reason: "The objective requires names.",
		})
		expect(text(noContract)).toContain("no current ready requirements contract")
		expect(rulingMock).not.toHaveBeenCalled()
		expect(harness.current()?.status).toBe("active")
	})

	it("routes final-review proposals through the amendment tool and keeps the review additions-only", async () => {
		// The final-review prompt guidance: existing criteria are surfaced as a
		// continue-verdict amendment proposal for the implementer to pass to
		// amend_ferment_v2_requirements; the review itself never rewrites them.
		const { buildVerifierTaskPrompt } = await import("./verifier-prompt.js")
		const prompt = buildVerifierTaskPrompt({
			objective: "ship the greeter",
			cwd,
			facts: { basis: "outside_git" },
			todos: [],
			requirements: {
				items: ITEMS,
				contractVersion: 1,
				provenance: "pre_implementation",
				idWatermark: 1,
			},
		})
		expect(prompt).toContain("amend_ferment_v2_requirements")
		expect(prompt).toContain("additions-only")
		expect(prompt).toContain("return a continue verdict")
	})
})
