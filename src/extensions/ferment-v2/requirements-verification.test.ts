import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, relative } from "node:path"
import { createReadTool } from "@earendil-works/pi-coding-agent"
import { expect, it, vi } from "vitest"
import { draftPrecedesImplementation } from "../../../tests/e2e/tui/support/ferment-v2-verifier.js"
import { setProjectScopeTrusted } from "../../project-scope-trust.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import type { FermentV2VerifierAgentRun } from "../agents/index.js"
import { evaluateFermentV2, type FermentV2EvaluationInput } from "./evaluator.js"
import { objectiveFilePath, saveObjectiveFile } from "./objective-file.js"
import {
	applyFermentV2Requirements,
	createFermentV2,
	createPendingFermentV2Requirements,
	editFermentV2,
	putFermentV2Entry,
	restoreFermentV2,
} from "./reducer.js"
import { digestFermentV2ObjectiveText } from "./requirements.js"
import { createRequirementsDraftGuard, runFermentV2RequirementsDraft } from "./requirements-agent.js"

vi.mock("./verifier-model.js", () => ({
	resolveFermentV2VerifierModel: async () => ({
		model: { id: "review", provider: "review", api: "openai-completions" },
		ref: "review/review",
		sameAsImplementer: false,
	}),
}))

const reviewItems = [
	{ id: "r1", requirement: "hello", source: "Objective", acceptance: "hello", category: "behavior" as const },
]
async function reviewEvaluation(input: FermentV2EvaluationInput, correction = false) {
	const ctx = createContext({ cwd: input.cwd })
	let prompt = ""
	let validRun: FermentV2VerifierAgentRun | undefined
	const result = await evaluateFermentV2(input, ctx, createExtensionApi().api, {
		gitProbe: async () => "outside_git",
		createGuard: () => ({
			extension: () => {},
			evidence: new Map([
				["e1", { id: "e1", toolName: "bash", input: { command: "check" }, isError: false, excerpt: "passed" }],
			]),
			createdFiles: new Set<string>(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
		}),
		spawn: async (options) => {
			prompt = options.prompt
			const child = createExtensionApi()
			const ext = options.extensionFactories.at(-1)
			if (typeof ext !== "function") throw new Error("missing ledger")
			await ext(child.api)
			await child
				.getRegisteredTool("record_requirements")
				.execute("record", { requirements: reviewItems }, undefined, undefined, ctx)
			validRun = {
				id: "review",
				status: "completed",
				toolCalls: 2,
				turns: 1,
				text: JSON.stringify({
					verdict: "met",
					reason: "verified",
					checks: [
						{
							requirementId: "r1",
							requirement: "hello",
							kind: "work",
							method: "command",
							status: "pass",
							failureMode: "missing hello",
							evidence: ["e1"],
						},
					],
				}),
			}
			return correction ? { ...validRun, text: "not JSON" } : validRun
		},
		resume: async () => validRun,
	})
	return { result, prompt }
}

it.each([
	false,
	true,
])("rejects completion without a ready requirements contract (correction: %s)", async (correction) => {
	const { result } = await reviewEvaluation(
		{
			objective: "hello",
			cwd: "/review",
			messages: [],
			todos: [],
			requirementsUnavailable: "both draft attempts failed",
		},
		correction,
	)
	expect(result).toMatchObject({
		verdict: "unavailable",
		diagnostics: { correctionCount: correction ? 1 : 0, failureType: "requirements_unavailable" },
	})
})

it.each([
	"changed",
	"deleted",
])("uses the persisted objective snapshot when the managed objective file is %s", async (state) => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "issue02-objective-")))
	setProjectScopeTrusted(cwd, true)
	try {
		const original = "ORIGINAL_REQUIREMENT_SNAPSHOT"
		const objective = saveObjectiveFile(original, cwd)
		const path = objectiveFilePath(objective, cwd)
		if (!path) throw new Error("missing objective path")
		if (state === "deleted") rmSync(path)
		else writeFileSync(path, "REPLACED_TASK_WITHOUT_REVISION")
		const pending = createPendingFermentV2Requirements({
			objectiveRevision: 1,
			objectiveText: original,
			objectiveDigest: digestFermentV2ObjectiveText(original),
			provenance: "pre_implementation",
		})
		const ready = applyFermentV2Requirements(
			createFermentV2(
				undefined,
				objective,
				"review",
				"2026-10-22T00:00:00.000Z",
				undefined,
				undefined,
				undefined,
				pending,
			),
			"review",
			1,
			0,
			{
				objectiveRevision: 1,
				objectiveDigest: pending.objectiveDigest,
				provenance: "pre_implementation",
				availability: "ready",
				items: reviewItems,
			},
			"2026-10-22T00:00:00.000Z",
		)
		const { prompt, result } = await reviewEvaluation({
			objective,
			cwd,
			messages: [],
			todos: [],
			requirements: ready.requirements,
		})
		expect(result.verdict).toBe("met")
		expect(prompt).not.toContain("REPLACED_TASK_WITHOUT_REVISION")
		expect(prompt).toContain(original)
	} finally {
		setProjectScopeTrusted(cwd, false)
		rmSync(cwd, { recursive: true, force: true })
	}
})

it("blocks SDK aliases from exposing candidate code outside the draft source view", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "issue02-view-")))
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "issue02-candidate-")))
	try {
		const candidate = join(outside, "candidate.txt")
		writeFileSync(candidate, "CANDIDATE_SENTINEL_OUTSIDE_DRAFT")
		const child = createExtensionApi()
		const guard = createRequirementsDraftGuard(root)
		if (typeof guard !== "function") throw new Error("unexpected factory shape")
		await guard(child.api)
		for (const path of [`@${candidate}`, `file://${candidate}`, `~/${relative(homedir(), candidate)}`]) {
			const decisions = await child.emit(
				"tool_call",
				{ toolName: "read", input: { path } },
				createContext({ cwd: root }),
			)
			const guardedRead = async () => {
				if (
					decisions.some(
						(decision) =>
							decision !== null && typeof decision === "object" && "block" in decision && decision.block === true,
					)
				)
					throw new Error("blocked by draft guard")
				return createReadTool(root).execute("read-candidate", { path }, undefined)
			}
			await expect(guardedRead()).rejects.toThrow("blocked by draft guard")
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	}
})

it("preserves stable requirement IDs through an edited objective and failed refresh", () => {
	const now = "2026-10-22T00:00:00.000Z"
	const digest = digestFermentV2ObjectiveText("hello")
	const items = [
		{ id: "r1", requirement: "hello", source: "Objective", acceptance: "hello", category: "behavior" as const },
	]
	const pending = createPendingFermentV2Requirements({
		objectiveRevision: 1,
		objectiveText: "hello",
		objectiveDigest: digest,
		provenance: "pre_implementation",
	})
	const initial = createFermentV2(undefined, "hello", "review", now, undefined, undefined, undefined, pending)
	const ready = applyFermentV2Requirements(
		initial,
		"review",
		1,
		0,
		{ objectiveRevision: 1, objectiveDigest: digest, provenance: "pre_implementation", availability: "ready", items },
		now,
	)
	const edited = editFermentV2(ready, "review", 1, "hello again", now)
	if (!edited.requirements) throw new Error("missing contract")
	const nextDigest = digestFermentV2ObjectiveText("hello again")
	const targeted = {
		...edited,
		requirements: {
			...edited.requirements,
			objectiveRevision: 2,
			objectiveText: "hello again",
			objectiveDigest: nextDigest,
		},
	}
	const unavailable = applyFermentV2Requirements(
		targeted,
		"review",
		2,
		1,
		{
			objectiveRevision: 2,
			objectiveDigest: nextDigest,
			provenance: "baseline_recovery",
			availability: "unavailable",
			unavailableReason: "provider down",
		},
		now,
	)
	expect(unavailable.requirements?.items).toEqual(items)
	expect(restoreFermentV2([putFermentV2Entry(unavailable)])).toEqual(unavailable)
	expect(() =>
		applyFermentV2Requirements(
			unavailable,
			"review",
			2,
			1,
			{
				objectiveRevision: 2,
				objectiveDigest: nextDigest,
				provenance: "baseline_recovery",
				availability: "ready",
				items,
			},
			now,
		),
	).not.toThrow()
})

it("does not prepare baseline source after drafting has already been cancelled", async () => {
	const abort = new AbortController()
	abort.abort()
	let release = (_value: boolean) => {}
	const ensure = vi.fn(
		() =>
			new Promise<boolean>((resolve) => {
				release = resolve
			}),
	)
	const child = createExtensionApi()
	const result = runFermentV2RequirementsDraft(
		{
			fermentV2Id: "review",
			revision: 1,
			objective: "hello",
			objectiveDigest: digestFermentV2ObjectiveText("hello"),
			cwd: "/review",
			baseline: "base",
			beforeImplementation: true,
			signal: abort.signal,
		},
		createContext(),
		child.api,
		{ reserveWorktree: () => ({ path: "/review-baseline", ensure, dispose: async () => {} }) },
	)
	release(false)
	expect(ensure).not.toHaveBeenCalled()
	expect(await result).toMatchObject({ status: "unavailable", diagnostics: { failureType: "cancelled" } })
})

it("detects an implementation request before an accepted draft instead of ignoring it", () => {
	const request = (messages: unknown[]) => ({
		method: "POST",
		url: "/openai/v1/chat/completions",
		headers: {},
		body: { messages },
	})
	const started = request([{ role: "system", content: "<ferment_v2_requirements_draft>" }])
	const accepted = request([
		{ role: "system", content: "<ferment_v2_requirements_draft>" },
		{ role: "tool", content: "Draft requirements recorded. End your turn now; the host takes over from here." },
	])
	const implementation = request([{ role: "user", content: "Implement the goal" }])
	expect(draftPrecedesImplementation([started, accepted, implementation])).toBe(true)
	expect(draftPrecedesImplementation([implementation, started, accepted, implementation])).toBe(false)
	expect(draftPrecedesImplementation([started, implementation])).toBe(false)
	expect(draftPrecedesImplementation([started, accepted])).toBe(false)
})

const additionItem = {
	id: "r2",
	requirement: "The greeter also says goodbye",
	source: "Objective: also say goodbye",
	acceptance: "Output equals goodbye",
	category: "behavior" as const,
}

/** A seeded review whose verifier adds an omitted obligation through record_requirements. */
async function additionEvaluation(
	input: FermentV2EvaluationInput,
	options: {
		recordCalls: { requirements: unknown[]; reason?: string; expectedVersion?: number }[]
		verdict: unknown
	},
) {
	const ctx = createContext({ cwd: input.cwd })
	let prompt = ""
	let validRun: FermentV2VerifierAgentRun | undefined
	const result = await evaluateFermentV2(input, ctx, createExtensionApi().api, {
		gitProbe: async () => "outside_git",
		createGuard: () => ({
			extension: () => {},
			evidence: new Map([
				["e1", { id: "e1", toolName: "bash", input: { command: "check" }, isError: false, excerpt: "passed" }],
			]),
			createdFiles: new Set<string>(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
		}),
		spawn: async (spawnOptions) => {
			prompt = spawnOptions.prompt
			const child = createExtensionApi()
			const ext = spawnOptions.extensionFactories.at(-1)
			if (typeof ext !== "function") throw new Error("missing ledger")
			await ext(child.api)
			const tool = child.getRegisteredTool("record_requirements")
			for (const call of options.recordCalls) {
				await tool.execute("record", call, undefined, undefined, ctx)
			}
			validRun = {
				id: "review",
				status: "completed",
				toolCalls: 2,
				turns: 1,
				text: JSON.stringify(options.verdict),
			}
			return validRun
		},
		resume: async () => validRun,
	})
	return { result, prompt }
}

function seededContract(items: typeof reviewItems) {
	const pending = createPendingFermentV2Requirements({
		objectiveRevision: 1,
		objectiveText: "hello",
		objectiveDigest: digestFermentV2ObjectiveText("hello"),
		provenance: "pre_implementation",
	})
	const ready = applyFermentV2Requirements(
		createFermentV2(undefined, "hello", "review", "2026-10-22T00:00:00.000Z", undefined, undefined, undefined, pending),
		"review",
		1,
		0,
		{
			objectiveRevision: 1,
			objectiveDigest: pending.objectiveDigest,
			provenance: "pre_implementation",
			availability: "ready",
			items,
		},
		"2026-10-22T00:00:00.000Z",
	)
	return ready.requirements
}

it("adds an omitted obligation in the same review and permits met when it is fully verified", async () => {
	const requirements = seededContract(reviewItems)
	if (!requirements) throw new Error("missing contract")
	const { result, prompt } = await additionEvaluation(
		{ objective: "hello", objectiveRevision: 1, cwd: "/review", messages: [], todos: [], requirements },
		{
			recordCalls: [
				{
					requirements: [...reviewItems, additionItem],
					reason: "Objective also requires goodbye",
					expectedVersion: 1,
				},
			],
			verdict: {
				verdict: "met",
				reason: "verified including the addition",
				checks: [
					{
						requirementId: "r1",
						requirement: "hello",
						kind: "work",
						method: "command",
						status: "pass",
						failureMode: "missing hello",
						evidence: ["e1"],
					},
					{
						requirementId: "r2",
						requirement: "The greeter also says goodbye",
						kind: "work",
						method: "command",
						status: "pass",
						failureMode: "missing goodbye",
						evidence: ["e1"],
					},
				],
			},
		},
	)
	expect(result).toMatchObject({ verdict: "met" })
	if (result.verdict === "unavailable") throw new Error("unexpected unavailable")
	expect(result.contractAdditions).toEqual([
		{ items: [additionItem], reason: "Objective also requires goodbye", basedOnVersion: 1 },
	])
	expect(result.diagnostics).toMatchObject({
		contractVersion: 1,
		finalContractVersion: 2,
		objectiveRevision: 1,
		contractProvenance: "pre_implementation",
	})
	expect(result.diagnostics.contractAdditions).toEqual(result.contractAdditions)
	// The prompt demands reverse coverage, the addition procedure, and the fresh-ID hint.
	expect(prompt).toContain("Reverse coverage")
	expect(prompt).toContain("expectedVersion 1")
	expect(prompt).toContain("a fresh ID such as r2")
	expect(prompt).toContain("never be changed, weakened, recategorized, or removed")
})

it("keeps an unmet addition on continue and still reports it for durable application", async () => {
	const requirements = seededContract(reviewItems)
	if (!requirements) throw new Error("missing contract")
	const { result } = await additionEvaluation(
		{ objective: "hello", objectiveRevision: 1, cwd: "/review", messages: [], todos: [], requirements },
		{
			recordCalls: [
				{
					requirements: [...reviewItems, additionItem],
					reason: "Objective also requires goodbye",
					expectedVersion: 1,
				},
			],
			verdict: {
				verdict: "continue",
				reason: "the addition is not implemented",
				checks: [
					{
						requirementId: "r1",
						requirement: "hello",
						kind: "work",
						method: "command",
						status: "pass",
						failureMode: "missing hello",
						evidence: ["e1"],
					},
					{
						requirementId: "r2",
						requirement: "The greeter also says goodbye",
						kind: "work",
						method: "command",
						status: "fail",
						failureMode: "goodbye missing",
						evidence: ["e1"],
					},
				],
			},
		},
	)
	expect(result).toMatchObject({ verdict: "continue" })
	if (result.verdict === "unavailable") throw new Error("unexpected unavailable")
	expect(result.contractAdditions).toEqual([
		{ items: [additionItem], reason: "Objective also requires goodbye", basedOnVersion: 1 },
	])
	expect(result.reason).toContain("goodbye")
})

it("rejects a met verdict that never checked an accepted addition", async () => {
	const requirements = seededContract(reviewItems)
	if (!requirements) throw new Error("missing contract")
	let correctionPrompt = ""
	const ctx = createContext({ cwd: "/review" })
	let validRun: FermentV2VerifierAgentRun | undefined
	const result = await evaluateFermentV2(
		{ objective: "hello", cwd: "/review", messages: [], todos: [], requirements },
		ctx,
		createExtensionApi().api,
		{
			gitProbe: async () => "outside_git",
			createGuard: () => ({
				extension: () => {},
				evidence: new Map([
					["e1", { id: "e1", toolName: "bash", input: { command: "check" }, isError: false, excerpt: "passed" }],
				]),
				createdFiles: new Set<string>(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
			}),
			spawn: async (spawnOptions) => {
				const child = createExtensionApi()
				const ext = spawnOptions.extensionFactories.at(-1)
				if (typeof ext !== "function") throw new Error("missing ledger")
				await ext(child.api)
				const tool = child.getRegisteredTool("record_requirements")
				await tool.execute(
					"record",
					{
						requirements: [...reviewItems, additionItem],
						reason: "Objective also requires goodbye",
						expectedVersion: 1,
					},
					undefined,
					undefined,
					ctx,
				)
				validRun = {
					id: "review",
					status: "completed",
					toolCalls: 2,
					turns: 1,
					text: JSON.stringify({
						verdict: "met",
						reason: "verified",
						checks: [
							{
								requirementId: "r1",
								requirement: "hello",
								kind: "work",
								method: "command",
								status: "pass",
								failureMode: "missing hello",
								evidence: ["e1"],
							},
						],
					}),
				}
				return validRun
			},
			resume: async (_id, prompt) => {
				correctionPrompt = prompt
				return validRun
			},
		},
	)
	// The uncovered addition routes to the single procedure correction; the second
	// response still lacks r2, so the run reports unavailable with the gap preserved.
	expect(result).toMatchObject({ verdict: "unavailable", diagnostics: { failureType: "procedure_incomplete" } })
	expect(correctionPrompt).toContain("r2")
	expect(result.diagnostics.validationGaps?.some((gap) => gap.includes("r2"))).toBe(true)
})
