import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { InlineExtension } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createModel } from "../__mocks__/model-registry.js"
import type { FermentV2VerifierAgentRun } from "../agents/index.js"
import { diffRequirementsAmendment } from "./requirements.js"
import {
	AMENDMENT_RULING_TOOL_NAME,
	buildFermentV2RequirementsAmendmentPrompt,
	buildFermentV2RequirementsDraftPrompt,
	createRequirementsAmendmentRulingGuard,
	createRequirementsAmendmentRulingLedger,
	createRequirementsDraftGuard,
	createRequirementsDraftLedger,
	type FermentV2RequirementsAmendmentDeps,
	type FermentV2RequirementsAmendmentInput,
	type FermentV2RequirementsDeps,
	type FermentV2RequirementsDraftInput,
	isDraftReadablePath,
	runFermentV2RequirementsAmendmentRuling,
	runFermentV2RequirementsDraft,
} from "./requirements-agent.js"
import { DEFAULT_FERMENT_V2_SETTINGS, getFermentV2Settings } from "./settings.js"

vi.mock("./settings.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./settings.js")>()
	return { ...actual, getFermentV2Settings: vi.fn() }
})

const fermentV2SettingsMock = vi.mocked(getFermentV2Settings)

const MODEL = createModel("drafter", "test")
const MODEL_CHOICE = { model: MODEL, ref: "test/drafter", sameAsImplementer: false }

function draftInput(overrides: Partial<FermentV2RequirementsDraftInput> = {}): FermentV2RequirementsDraftInput {
	return {
		fermentV2Id: "f1",
		revision: 1,
		objective: "ship the greeter",
		objectiveDigest: "a".repeat(64),
		cwd: "/host/cwd",
		beforeImplementation: true,
		...overrides,
	}
}

describe("requirements draft read confinement", () => {
	let root: string

	async function load(extension: InlineExtension) {
		const child = createExtensionApi()
		if (typeof extension === "function") await extension(child.api)
		else await extension.factory(child.api)
		const handler = child.getHandler<{ toolName: string; input?: unknown }, unknown>("tool_call")
		return (toolName: string, input?: unknown) => handler({ toolName, input }, createContext({ cwd: root }))
	}

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-draft-guard-")))
		writeFileSync(join(root, "source.ts"), "export const greeting = 'hello'\n")
		mkdirSync(join(root, "nested"))
		writeFileSync(join(root, "nested", "deep.ts"), "export const deep = 1\n")
	})

	afterEach(() => {
		rmSync(root, { recursive: true, force: true })
	})

	it("allows paths inside the view root, including defaults and traversal that stays inside", () => {
		expect(isDraftReadablePath(undefined, root)).toBe(true)
		expect(isDraftReadablePath("", root)).toBe(true)
		expect(isDraftReadablePath("source.ts", root)).toBe(true)
		expect(isDraftReadablePath("nested/../source.ts", root)).toBe(true)
		expect(isDraftReadablePath(join(root, "nested", "deep.ts"), root)).toBe(true)
	})

	it("rejects parent traversal, absolute paths outside the root, and nonexistent escapes", () => {
		expect(isDraftReadablePath("../outside.ts", root)).toBe(false)
		expect(isDraftReadablePath("/etc/hostname", root)).toBe(false)
		expect(isDraftReadablePath(join(root, "..", "elsewhere.ts"), root)).toBe(false)
		expect(isDraftReadablePath(42, root)).toBe(false)
	})

	it("rejects symlink escapes out of the view root", () => {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-draft-outside-")))
		writeFileSync(join(outside, "candidate.ts"), "candidate code")
		try {
			symlinkSync(join(outside, "candidate.ts"), join(root, "escape.ts"))
			expect(isDraftReadablePath("escape.ts", root)).toBe(false)
		} finally {
			rmSync(outside, { recursive: true, force: true })
		}
	})

	it("rejects .git metadata that would expose the candidate checkout", () => {
		expect(isDraftReadablePath(".git", root)).toBe(false)
		expect(isDraftReadablePath(".git/config", root)).toBe(false)
		expect(isDraftReadablePath(join(root, "nested", ".git", "HEAD"), root)).toBe(false)
	})

	it("checks normalized aliases and read fallback symlinks against the actual source root", () => {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-draft-candidate-")))
		try {
			writeFileSync(join(outside, "candidate code.txt"), "candidate sentinel")
			const path = join(outside, "candidate code.txt")
			for (const toolName of ["read", "grep", "find", "ls"]) {
				expect(isDraftReadablePath(`@${path}`, root, toolName)).toBe(false)
				expect(isDraftReadablePath(`file://${path.replaceAll(" ", "%20")}`, root, toolName)).toBe(false)
				expect(isDraftReadablePath(path.replaceAll(" ", "\u00A0"), root, toolName)).toBe(false)
			}
			symlinkSync(path, join(root, "file\u2019.txt"))
			expect(isDraftReadablePath("file'.txt", root, "read")).toBe(false)
			writeFileSync(join(root, ".git"), "gitdir: candidate checkout")
			symlinkSync(join(root, ".git"), join(root, "metadata"))
			const alias = join(outside, "source-alias")
			symlinkSync(root, alias)
			expect(isDraftReadablePath("metadata", alias, "read")).toBe(false)
		} finally {
			rmSync(outside, { recursive: true, force: true })
		}
	})

	it("the host guard blocks every non-read tool and confines read paths", async () => {
		const guard = createRequirementsDraftGuard(root)
		const call = await load(guard)

		expect(await call("read", { path: "source.ts" })).toBeUndefined()
		expect(await call("grep", { path: undefined })).toBeUndefined()
		expect(await call("find", { path: "." })).toBeUndefined()
		expect(await call("ls", { path: "nested" })).toBeUndefined()
		expect(await call("record_requirements")).toBeUndefined()

		expect(await call("bash", { command: "cat /etc/hostname" })).toMatchObject({ block: true })
		expect(await call("write", { path: join(root, "new.ts") })).toMatchObject({ block: true })
		expect(await call("edit", { path: "source.ts" })).toMatchObject({ block: true })
		expect(await call("Agent", {})).toMatchObject({ block: true })
		expect(await call("read", { path: "../outside.ts" })).toMatchObject({ block: true })
		expect(await call("grep", { path: ".git/config" })).toMatchObject({ block: true })
	})

	it("blocks all reads when no source view exists (objective-only recovery)", async () => {
		const guard = createRequirementsDraftGuard(undefined)
		const call = await load(guard)
		expect(await call("read", { path: "source.ts" })).toMatchObject({ block: true })
	})
})

describe("requirements draft prompt", () => {
	it("renders the objective, the authorized plan, and the source view", () => {
		const prompt = buildFermentV2RequirementsDraftPrompt({
			objective: "ship the greeter",
			planText: "Plan: build the greeter",
			view: { kind: "baseline", root: "/view" },
		})
		expect(prompt).toContain("<ferment_v2_requirements_draft>")
		expect(prompt).toContain("ship the greeter")
		expect(prompt).toContain("Plan: build the greeter")
		expect(prompt).toContain("/view")
		expect(prompt).toContain("frozen checkout")
		expect(prompt).toContain("record_requirements")
	})

	it("states the workspace-view limits and the objective-only fallback honestly", () => {
		const live = buildFermentV2RequirementsDraftPrompt({
			objective: "o",
			view: { kind: "workspace", root: "/work" },
		})
		expect(live).toContain("live, not a frozen historical checkout")
		const none = buildFermentV2RequirementsDraftPrompt({ objective: "o", view: { kind: "none" } })
		expect(none).toContain("no historical source is available")
		expect(none).not.toContain("Source view (host-provided")
	})
})

describe("runFermentV2RequirementsDraft", () => {
	let cwd: string

	beforeEach(() => {
		cwd = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-draft-run-")))
		fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS })
	})

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	const ctx = createContext()
	const pi = createExtensionApi().api
	const depsWithModel = (deps: FermentV2RequirementsDeps): FermentV2RequirementsDeps => ({
		resolveModel: async () => MODEL_CHOICE,
		...deps,
	})

	it("maps a recorded list to a ready outcome with the drafter model and usage", async () => {
		const items = [{ id: "r1", requirement: "a", source: "s", acceptance: "c", category: "behavior" as const }]
		const spawn = vi.fn(async (input: { model: unknown; cwd: string; maxDuration: number }) => {
			expect(input.model).toBe(MODEL)
			expect(input.cwd).toBe(cwd)
			expect(input.maxDuration).toBe(120)
			return {
				id: "run-1",
				text: "",
				status: "completed",
				toolCalls: 1,
				turns: 1,
			} satisfies FermentV2VerifierAgentRun
		})
		const deps: FermentV2RequirementsDeps = { spawn }
		// The ledger captures items through its in-session tool; simulate the
		// draft session by resolving the outcome from the spawn seam.
		const outcome = await runFermentV2RequirementsDraft(draftInput({ cwd }), ctx, pi, {
			...depsWithModel(deps),
			spawn: async (spawnInput) => {
				await spawn(spawnInput)
				// Invoke the ledger's tool exactly as the child session would.
				const child = createExtensionApi()
				const ledgerFactory = spawnInput.extensionFactories.at(-1)
				if (typeof ledgerFactory !== "function") throw new Error("Expected the draft ledger")
				await ledgerFactory(child.api)
				await child
					.getRegisteredTool("record_requirements")
					.execute("call-1", { requirements: items }, undefined, undefined, ctx)
				return {
					id: "run-1",
					text: "",
					status: "completed",
					toolCalls: 1,
					turns: 1,
				} satisfies FermentV2VerifierAgentRun
			},
		})
		expect(outcome).toMatchObject({
			status: "ready",
			provenance: "pre_implementation",
			items,
			objectiveDigest: "a".repeat(64),
			objectiveRevision: 1,
		})
		expect(outcome.diagnostics.model).toBe("test/drafter")
	})

	it("reports the drafter system as unavailable when the manager is absent", async () => {
		const outcome = await runFermentV2RequirementsDraft(draftInput({ cwd }), ctx, pi, depsWithModel({}))
		expect(outcome.status).toBe("unavailable")
		expect(outcome.diagnostics.failureType).toBe("agent_unavailable")
		expect(outcome.diagnostics.model).toBe("test/drafter")
	})

	it("maps an errored spawn to a classified failure and keeps usage at zero", async () => {
		const outcome = await runFermentV2RequirementsDraft(
			draftInput({ cwd }),
			ctx,
			pi,
			depsWithModel({
				spawn: async () => ({ id: "r", text: "", status: "error", error: "boom", toolCalls: 0, turns: 0 }),
			}),
		)
		expect(outcome.status).toBe("unavailable")
		expect(outcome.diagnostics.failureType).toBe("call_failed")
		expect(outcome.usage.totalTokens).toBe(0)
	})

	it("maps an aborted caller signal to a cancelled outcome", async () => {
		const controller = new AbortController()
		controller.abort()
		const outcome = await runFermentV2RequirementsDraft(
			draftInput({ cwd, signal: controller.signal }),
			ctx,
			pi,
			depsWithModel({}),
		)
		expect(outcome).toMatchObject({ status: "unavailable" })
		expect(outcome.diagnostics.failureType).toBe("cancelled")
	})

	it("reports invalid output when the run ends without a recorded list", async () => {
		const outcome = await runFermentV2RequirementsDraft(
			draftInput({ cwd }),
			ctx,
			pi,
			depsWithModel({
				spawn: async () => ({ id: "r", text: "no tool call", status: "completed", toolCalls: 0, turns: 1 }),
			}),
		)
		expect(outcome).toMatchObject({ status: "unavailable" })
		expect(outcome.diagnostics.failureType).toBe("invalid_output")
	})

	it("derives recovery provenance from the source view that actually served the draft", async () => {
		const reserveWorktree = vi.fn(() => undefined)
		const outcome = await runFermentV2RequirementsDraft(
			draftInput({ cwd, beforeImplementation: false, baseline: "abc" }),
			ctx,
			pi,
			depsWithModel({ spawn: async () => undefined, reserveWorktree }),
		)
		// The baseline could not be materialized after implementation began:
		// objective-only, never candidate-informed.
		expect(outcome.provenance).toBe("objective_only")
		expect(reserveWorktree).toHaveBeenCalledWith(cwd, "abc")
	})

	it("uses the baseline worktree as the read-only view when it can be created", async () => {
		const worktreePath = join(cwd, "worktree")
		const disposed = vi.fn()
		const reserveWorktree = vi.fn(() => ({
			path: worktreePath,
			ensure: async () => true,
			dispose: disposed,
		}))
		const seenCwds: string[] = []
		const outcome = await runFermentV2RequirementsDraft(draftInput({ cwd, baseline: "abc" }), ctx, pi, {
			reserveWorktree,
			resolveModel: async () => MODEL_CHOICE,
			spawn: async (input) => {
				seenCwds.push(input.cwd)
				return undefined
			},
		})
		expect(seenCwds).toEqual([worktreePath])
		expect(disposed).toHaveBeenCalled()
		expect(outcome.provenance).toBe("pre_implementation")
	})

	it.each(["cancel", "timeout"])("bounds source preparation on %s and disposes the reservation", async (reason) => {
		fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS, evaluationTimeoutMs: 20 })
		const controller = new AbortController()
		const dispose = vi.fn(async () => {})
		const ensure = vi.fn(
			(signal?: AbortSignal) =>
				new Promise<boolean>((resolve) => {
					if (!signal) throw new Error("Preparation must receive a cancellation signal")
					signal.addEventListener("abort", () => resolve(false), { once: true })
				}),
		)
		const spawn = vi.fn(async () => undefined)
		const pending = runFermentV2RequirementsDraft(
			draftInput({ cwd, baseline: "base", signal: controller.signal }),
			ctx,
			pi,
			depsWithModel({
				reserveWorktree: () => ({ path: cwd, ensure, dispose }),
				spawn,
			}),
		)
		expect(ensure).toHaveBeenCalledOnce()
		if (reason === "cancel") controller.abort()
		// Keep the event loop live while AbortSignal.timeout's unref'ed timer fires.
		const keepAlive = setTimeout(() => {}, 1000)
		try {
			expect(await pending).toMatchObject({
				status: "unavailable",
				diagnostics: { failureType: reason === "cancel" ? "cancelled" : "timeout", providerRequestCount: 0 },
			})
		} finally {
			clearTimeout(keepAlive)
		}
		expect(dispose).toHaveBeenCalledOnce()
		expect(spawn).not.toHaveBeenCalled()
	})

	it.each([false, "throw"])("cleans up preparation failure %s and returns an unavailable outcome", async (failure) => {
		const dispose = vi.fn(async () => {})
		const outcome = await runFermentV2RequirementsDraft(
			draftInput({ cwd, baseline: "base" }),
			ctx,
			pi,
			depsWithModel({
				reserveWorktree: () => ({
					path: cwd,
					ensure: async () => {
						if (failure === "throw") throw new Error("checkout failed")
						return false
					},
					dispose,
				}),
				spawn: async () => undefined,
			}),
		)
		expect(outcome.status).toBe("unavailable")
		expect(dispose).toHaveBeenCalledOnce()
	})

	it("supplies retained obligations and the next fresh ID to a refresh and rejects retired IDs in-session", async () => {
		const retained = {
			id: "r3",
			requirement: "Keep hello",
			source: "Objective",
			acceptance: "hello",
			category: "behavior" as const,
		}
		const previousContract = { items: [retained], idWatermark: 5 }
		const prompt = buildFermentV2RequirementsDraftPrompt({
			objective: "Keep hello and add goodbye",
			view: { kind: "none" },
			previousContract,
		})
		expect(prompt).toContain("starting at r6")
		expect(prompt).toContain(JSON.stringify([retained]))
		const ledger = createRequirementsDraftLedger(previousContract)
		const child = createExtensionApi()
		if (typeof ledger.extension !== "function") throw new Error("Expected draft ledger")
		await ledger.extension(child.api)
		const tool = child.getRegisteredTool("record_requirements")
		const retired = await tool.execute(
			"retired",
			{ requirements: [{ ...retained, id: "r1" }] },
			undefined,
			undefined,
			ctx,
		)
		expect(retired).toMatchObject({ isError: true })
		expect(ledger.items).toBeUndefined()
		const items = [retained, { ...retained, id: "r6", requirement: "Add goodbye" }]
		await tool.execute("valid", { requirements: items }, undefined, undefined, ctx)
		expect(ledger.items).toEqual(items)
	})
})

describe("requirements amendment ruling", () => {
	const CURRENT = [
		{
			id: "r1",
			requirement: "returns hello",
			source: "Objective: return hello",
			acceptance: "output is hello",
			category: "behavior" as const,
		},
		{
			id: "r2",
			requirement: "logs each greeting",
			source: "Repository: logger",
			acceptance: "one log line",
			category: "constraint" as const,
		},
	]
	const PROPOSED = [
		{
			id: "r1",
			requirement: "returns hello by name",
			source: "Objective: greet by name",
			acceptance: "output is hello <name>",
			category: "behavior" as const,
		},
		{
			id: "r3",
			requirement: "validates names",
			source: "Objective: named input",
			acceptance: "empty name rejected",
			category: "behavior" as const,
		},
	]

	async function loadExtension(extension: InlineExtension) {
		const child = createExtensionApi()
		if (typeof extension === "function") await extension(child.api)
		else await extension.factory(child.api)
		return child
	}

	beforeEach(() => {
		fermentV2SettingsMock.mockReturnValue({ ...DEFAULT_FERMENT_V2_SETTINGS })
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function amendmentInput(
		overrides: Partial<FermentV2RequirementsAmendmentInput> = {},
	): FermentV2RequirementsAmendmentInput {
		const diff = diffRequirementsAmendment(CURRENT, PROPOSED, 2)
		if (!diff) throw new Error("fixture diff invalid")
		return {
			fermentV2Id: "f1",
			revision: 1,
			objective: "ship a greeter that greets by name",
			objectiveDigest: "b".repeat(64),
			contractVersion: 1,
			currentItems: CURRENT,
			proposedItems: PROPOSED,
			diff,
			reason: "Objective names the input form; the current criteria under-specify it.",
			cwd: "/host/cwd",
			...overrides,
		}
	}

	it("renders the objective, both lists, the computed diff, the evidence, and the decision policy", async () => {
		const prompt = buildFermentV2RequirementsAmendmentPrompt(amendmentInput())
		expect(prompt).toContain("<ferment_v2_requirements_amendment_task>")
		expect(prompt).toContain("greets by name")
		expect(prompt).toContain("Additions: r3")
		expect(prompt).toContain("Changes: r1")
		expect(prompt).toContain("Removals: r2 (logs each greeting)")
		expect(prompt).toContain("under-specify it")
		expect(prompt).toContain("submit_amendment_ruling")
		expect(prompt).toContain("Reject scope weakening")
		// The tool's own description carries the atomic decision contract.
		const ledger = createRequirementsAmendmentRulingLedger()
		const child = await loadExtension(ledger.extension)
		expect(child.getRegisteredTool(AMENDMENT_RULING_TOOL_NAME).description).toContain('"decision": "accept" | "reject"')
		expect(child.getRegisteredTool(AMENDMENT_RULING_TOOL_NAME).description).toContain("atomic")
	})

	it("records one atomic decision and rejects an empty reason", async () => {
		const ledger = createRequirementsAmendmentRulingLedger()
		const child = await loadExtension(ledger.extension)
		const tool = child.getRegisteredTool(AMENDMENT_RULING_TOOL_NAME)
		expect(ledger.ruling).toBeUndefined()
		const empty = await tool.execute("c1", { decision: "accept", reason: "   " }, undefined, undefined, createContext())
		expect(empty).toMatchObject({ isError: true })
		await tool.execute(
			"c2",
			{ decision: "reject", reason: "No source justifies removing the log obligation." },
			undefined,
			undefined,
			createContext(),
		)
		expect(ledger.ruling).toEqual({ decision: "reject", reason: "No source justifies removing the log obligation." })
		// The last valid call wins within one bounded session.
		await tool.execute(
			"c3",
			{ decision: "accept", reason: "Objective clause 2 requires it." },
			undefined,
			undefined,
			createContext(),
		)
		expect(ledger.ruling).toEqual({ decision: "accept", reason: "Objective clause 2 requires it." })
	})

	const ctx = createContext()
	const pi = createExtensionApi().api
	const depsWithModel = (deps: FermentV2RequirementsAmendmentDeps): FermentV2RequirementsAmendmentDeps => ({
		resolveModel: async () => MODEL_CHOICE,
		...deps,
	})

	it("maps a submitted accept ruling to an accepted outcome with model and usage", async () => {
		const outcome = await runFermentV2RequirementsAmendmentRuling(amendmentInput(), ctx, pi, {
			...depsWithModel({}),
			spawn: async (spawnInput) => {
				expect(spawnInput.cwd).toBe("/host/cwd")
				expect(spawnInput.maxDuration).toBe(120)
				const child = createExtensionApi()
				const ledgerFactory = spawnInput.extensionFactories.at(-1)
				if (typeof ledgerFactory !== "function") throw new Error("Expected the ruling ledger")
				await ledgerFactory(child.api)
				await child
					.getRegisteredTool(AMENDMENT_RULING_TOOL_NAME)
					.execute(
						"call-1",
						{ decision: "accept", reason: "The objective's greeting clause names the input form." },
						undefined,
						undefined,
						ctx,
					)
				return {
					id: "run-1",
					text: "",
					status: "completed",
					toolCalls: 1,
					turns: 1,
				} satisfies FermentV2VerifierAgentRun
			},
		})
		expect(outcome).toMatchObject({
			status: "accepted",
			reason: "The objective's greeting clause names the input form.",
			objectiveDigest: "b".repeat(64),
			objectiveRevision: 1,
		})
		expect(outcome.diagnostics.model).toBe("test/drafter")
	})

	it("maps a submitted reject ruling to a rejected outcome", async () => {
		const outcome = await runFermentV2RequirementsAmendmentRuling(amendmentInput(), ctx, pi, {
			...depsWithModel({}),
			spawn: async (spawnInput) => {
				const child = createExtensionApi()
				const ledgerFactory = spawnInput.extensionFactories.at(-1)
				if (typeof ledgerFactory !== "function") throw new Error("Expected the ruling ledger")
				await ledgerFactory(child.api)
				await child
					.getRegisteredTool(AMENDMENT_RULING_TOOL_NAME)
					.execute(
						"call-1",
						{ decision: "reject", reason: "Implementation difficulty never justifies removing an obligation." },
						undefined,
						undefined,
						ctx,
					)
				return {
					id: "run-1",
					text: "",
					status: "completed",
					toolCalls: 1,
					turns: 1,
				} satisfies FermentV2VerifierAgentRun
			},
		})
		expect(outcome.status).toBe("rejected")
		expect(outcome.reason).toContain("Implementation difficulty")
	})

	it("reports the ruler system as unavailable when the manager is absent", async () => {
		const outcome = await runFermentV2RequirementsAmendmentRuling(amendmentInput(), ctx, pi, depsWithModel({}))
		expect(outcome.status).toBe("unavailable")
		expect(outcome.diagnostics.failureType).toBe("agent_unavailable")
	})

	it("maps an aborted caller signal to a cancelled outcome", async () => {
		const controller = new AbortController()
		controller.abort()
		const outcome = await runFermentV2RequirementsAmendmentRuling(
			amendmentInput({ signal: controller.signal }),
			ctx,
			pi,
			depsWithModel({}),
		)
		expect(outcome.status).toBe("unavailable")
		expect(outcome.diagnostics.failureType).toBe("cancelled")
	})

	it("reports invalid output when the run ends without a submitted ruling", async () => {
		const outcome = await runFermentV2RequirementsAmendmentRuling(amendmentInput(), ctx, pi, {
			...depsWithModel({
				spawn: async () => ({ id: "r", text: "no ruling", status: "completed", toolCalls: 0, turns: 1 }),
			}),
		})
		expect(outcome.status).toBe("unavailable")
		expect(outcome.diagnostics.failureType).toBe("invalid_output")
	})

	it("confines the ruling's reads to the workspace and blocks every other tool", async () => {
		const guard = createRequirementsAmendmentRulingGuard("/host/cwd")
		const child = await loadExtension(guard)
		const handler = child.getHandler<{ toolName: string; input?: unknown }, unknown>("tool_call")
		if (!handler) throw new Error("expected the guard handler")
		const call = (toolName: string, input?: unknown) =>
			handler({ toolName, input }, createContext({ cwd: "/host/cwd" }))
		expect(await call("read", { path: "src/index.ts" })).toBeUndefined()
		expect(await call("grep", { path: "." })).toBeUndefined()
		expect(await call(AMENDMENT_RULING_TOOL_NAME, {})).toBeUndefined()
		expect(await call("bash", { command: "pnpm test" })).toMatchObject({ block: true })
		expect(await call("write", { path: "/host/cwd/x.ts" })).toMatchObject({ block: true })
		expect(await call("edit", { path: "src/index.ts" })).toMatchObject({ block: true })
		expect(await call("record_requirements", {})).toMatchObject({ block: true })
		expect(await call("read", { path: "../outside.ts" })).toMatchObject({ block: true })
		expect(await call("read", { path: ".git/config" })).toMatchObject({ block: true })
	})
})
