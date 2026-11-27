import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { setOrgPolicyForTests } from "../../org-policy.test-utils.js"
import { setResourceOverride } from "../../resources/store.js"
import { parseFermentCommand } from "../ferment/command-parser.js"
import { getFermentArgumentCompletions } from "../ferment/commands.js"
import { markFermentLegacyLoaded, resetFermentLegacyLoadedForTests } from "../ferment/resource.js"
import { FERMENT_LEGACY_RESOURCE_ID } from "../ferment/resource-id.js"
import {
	FERMENT_LEGACY_WORDS,
	FERMENT_V2_COMMAND_COMPLETIONS,
	formatFermentLegacyWordHint,
	formatFermentV2Accounting,
	formatFermentV2Duration,
	formatFermentV2Status,
	formatFermentV2Summary,
	formatFermentV2VerifyingStatus,
	parseFermentV2Command,
} from "./command.js"
import { FERMENT_V2_STATUSES, type FermentV2Status, type SessionFermentV2 } from "./types.js"

const acpHost = vi.hoisted(() => ({ value: false }))
vi.mock("../../modes/acp/state.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../modes/acp/state.js")>()),
	isAcpSessionHost: () => acpHost.value,
}))

describe("Ferment V2 command", () => {
	it("parses management commands and inline objectives", () => {
		expect(parseFermentV2Command("")).toEqual({ action: "show" })
		expect(parseFermentV2Command(" edit ")).toEqual({ action: "edit" })
		expect(parseFermentV2Command("edit new objective")).toEqual({ action: "edit", objective: "new objective" })
		expect(parseFermentV2Command("pause")).toEqual({ action: "pause" })
		expect(parseFermentV2Command("resume")).toEqual({ action: "resume" })
		expect(parseFermentV2Command("pause after deployment")).toEqual({
			action: "set",
			objective: "pause after deployment",
		})
		expect(parseFermentV2Command("--tokens 1.5k ship it")).toEqual({
			action: "set",
			objective: "ship it",
			tokenBudget: 1_500,
		})
		expect(parseFermentV2Command("ship it --tokens=2m")).toEqual({
			action: "set",
			objective: "ship it",
			tokenBudget: 2_000_000,
		})
		expect(() => parseFermentV2Command("--tokens nope ship it")).toThrow("Token budget must be a positive number")
	})

	it("clears only with the canonical spelling", () => {
		expect(parseFermentV2Command("clear")).toEqual({ action: "clear" })
		expect(parseFermentV2Command("CLEAR")).toEqual({ action: "clear" })
		for (const objective of ["stop", "off", "reset", "none", "cancel"]) {
			expect(parseFermentV2Command(objective)).toEqual({ action: "set", objective })
		}
	})

	it("offers the required argument completions", () => {
		expect(FERMENT_V2_COMMAND_COMPLETIONS).toEqual(["edit", "pause", "resume", "clear"])
	})

	it("formats the empty state and every Ferment V2 status", () => {
		expect(formatFermentV2Summary(undefined)).toContain("No Ferment is currently set")
		expect(formatFermentV2Summary(undefined, 0)).toContain("Use /ferment <objective>")
		for (const status of ["active", "paused", "blocked", "budget_limited", "complete"] satisfies FermentV2Status[]) {
			const summary = formatFermentV2Summary(fermentV2(status))
			expect(summary).toContain(`Status: ${status}`)
			expect(summary).toContain("Revision: 3")
			expect(summary).toContain("Objective: ship it")
			expect(summary).toContain("Fermenting time: <1m · 1.5k tokens")
		}
	})

	it("uses a neutral summary for an automatic approved plan while preserving manual branding", () => {
		const manual = formatFermentV2Summary(fermentV2("active"))
		const automatic = formatFermentV2Summary({
			...fermentV2("active"),
			presentation: { kind: "approved-plan", title: "Cache Layer", planPath: "/tmp/cache-layer.md" },
		})

		expect(manual.startsWith("Ferment: ship it\n")).toBe(true)
		expect(automatic).toContain("Plan execution: Cache Layer")
		expect(automatic).toContain("Commands: /ferment edit, /ferment pause, /ferment clear")
	})

	describe.each(FERMENT_V2_STATUSES)("approved plan summary while %s", (status) => {
		it.each([
			"/tmp/cache-layer.md",
			undefined,
		])("shows only the saved reference (%s), preserving the snapshot", (planPath) => {
			const run = {
				...fermentV2(status),
				objective: "Internal approved objective with exact requirements.",
				presentation: {
					kind: "approved-plan",
					title: "Cache Layer",
					planPath,
					planText: "# Full approved Markdown\nDo not repeat this in a summary.",
				},
			} satisfies SessionFermentV2
			const before = structuredClone(run)
			const summary = formatFermentV2Summary(run)
			expect(summary).toContain(`Plan: ${planPath ?? "no saved file"}`)
			expect(summary).toContain(`Status: ${status}`)
			expect(summary).not.toContain("Objective:")
			expect(summary).not.toContain(run.objective)
			expect(summary).not.toContain(run.presentation.planText)
			expect(run).toEqual(before)
		})
	})

	it("shows the run state and resume hint without adding a prompt decoration", () => {
		expect(formatFermentV2Status(undefined)).toBeUndefined()
		expect(formatFermentV2Status(fermentV2("active"))).toBe("◈ Ferment: running · ship it")
		expect(formatFermentV2Status(fermentV2("active"), true)).toBe("◈ Ferment: checking · ship it")
		expect(formatFermentV2Status(fermentV2("paused"), true)).toBe("◈ Ferment: paused · ship it · /ferment resume")
		expect(formatFermentV2Status(fermentV2("blocked"))).toBe("◈ Ferment: blocked · ship it · /ferment resume")
		expect(formatFermentV2Status(fermentV2("complete"))).toBe("◈ Ferment: complete · ship it")
		expect(formatFermentV2Status(fermentV2("budget_limited"))).toBe("◈ Ferment: budget limited · ship it")
	})

	it("shows the verifying model, elapsed time and revert warning while the verifier runs", () => {
		expect(formatFermentV2VerifyingStatus(undefined, 0)).toBe(
			"◈ Ferment: verifying · … · 0ms · file edits may be reverted",
		)
		expect(formatFermentV2VerifyingStatus("judge/independent", 5_000)).toBe(
			"◈ Ferment: verifying · judge/independent · 5.0s · file edits may be reverted",
		)
		expect(formatFermentV2VerifyingStatus("judge/independent", -1_000)).toBe(
			"◈ Ferment: verifying · judge/independent · 0ms · file edits may be reverted",
		)
	})

	it("shows the verifier usage breakdown in the full command summary", () => {
		const verified = {
			...fermentV2("active"),
			evaluationCount: 2,
			verifierUsage: {
				runs: 2,
				input: 4_000,
				output: 1_000,
				cacheRead: 500,
				cacheWrite: 200,
				totalTokens: 5_700,
				costUsd: 0.0512,
			},
		}
		expect(formatFermentV2Summary(verified)).toContain("Verifier: 2 runs · 5.7k tokens · $0.05")
		expect(formatFermentV2Summary(fermentV2("active"))).not.toContain("Verifier:")
	})

	it("shows evaluation details only in the full command summary", () => {
		const evaluated = {
			...fermentV2("active"),
			evaluationCount: 2,
			lastEvaluation: {
				verdict: "continue" as const,
				reason: "missing smoke test",
				model: "test/judge",
				evaluatedAt: "2026-07-16T10:02:00.000Z",
			},
		}
		expect(formatFermentV2Summary(evaluated)).toContain(
			"Evaluations: 2\nLast evaluation: continue — missing smoke test (evaluator: test/judge)",
		)
		expect(formatFermentV2Summary(evaluated)).not.toContain("same as implementer")
		expect(formatFermentV2Accounting(evaluated)).toBe("<1m · 1.5k tokens")
	})

	it("marks the evaluator model as the implementer's in the summary", () => {
		const evaluated = {
			...fermentV2("active"),
			lastEvaluation: {
				verdict: "met" as const,
				reason: "all checks pass",
				model: "test/session",
				sameModelAsImplementer: true,
				evaluatedAt: "2026-07-16T10:02:00.000Z",
			},
		}
		expect(formatFermentV2Summary(evaluated)).toContain(
			"Last evaluation: met — all checks pass (evaluator: test/session, same as implementer)",
		)
	})

	it("shows a bounded name in the footer and the complete objective in the summary", () => {
		const objective =
			"Implement a streaming parser with incremental input and preserve every existing API and test case"
		const run = { ...fermentV2("active"), objective }
		const status = formatFermentV2Status(run)
		expect(status).toBe("◈ Ferment: running · Implement a streaming parser with")
		expect(formatFermentV2Summary(run)).toContain(`Objective: ${objective}`)
		expect(formatFermentV2Status({ ...run, name: "Streaming parser" })).toBe("◈ Ferment: running · Streaming parser")
	})

	it("shows the persisted blocked reason", () => {
		expect(formatFermentV2Summary({ ...fermentV2("blocked"), blockedReason: "needs user input" })).toContain(
			"Blocked reason: needs user input",
		)
	})

	it("formats accounting time in minutes and hours", () => {
		expect(formatFermentV2Duration(249_000)).toBe("4m")
		expect(formatFermentV2Duration(60 * 60_000)).toBe("1h")
		expect(formatFermentV2Duration(65 * 60_000)).toBe("1h 5m")
		expect(formatFermentV2Accounting(fermentV2("active"))).toBe("<1m · 1.5k tokens")
		expect(formatFermentV2Accounting({ ...fermentV2("active"), timeUsedMs: 19 * 60_000 })).toBe("19m · 1.5k tokens")
		expect(formatFermentV2Accounting({ ...fermentV2("active"), timeUsedMs: 65 * 60_000 })).toBe("1h 5m · 1.5k tokens")
		expect(formatFermentV2Accounting({ ...fermentV2("active"), tokenBudget: 2_000 })).toBe("<1m · 1.5k/2.0k tokens")
	})
})

function fermentV2(status: FermentV2Status): SessionFermentV2 {
	return {
		schemaVersion: 1,
		id: "ferment-v2-a",
		revision: 3,
		objective: "ship it",
		status,
		tokensUsed: 1_500,
		timeUsedMs: 2_000,
		createdAt: "2026-07-16T10:00:00.000Z",
		updatedAt: "2026-07-16T10:00:00.000Z",
	}
}

describe("legacy Ferment words typed into /ferment", () => {
	// Regression: before the fix every one of these became a V2 objective.
	it.each([...FERMENT_LEGACY_WORDS])("returns a hint for the bare legacy word %s", (word) => {
		expect(parseFermentV2Command(word)).toEqual({ action: "legacy-hint", word })
	})

	it.each([
		["  LIST ", "list"],
		["Exit", "exit"],
		["\tone-SHOT\n", "one-shot"],
		["   Auto", "auto"],
	])("ignores case and surrounding whitespace in %j", (input, word) => {
		expect(parseFermentV2Command(input)).toEqual({ action: "legacy-hint", word })
	})

	it.each([
		["delete old-auth", "delete", "old-auth"],
		['delete "Old Auth"', "delete", '"Old Auth"'],
		["switch abc123", "switch", "abc123"],
		['switch "Build Tetris" --force', "switch", '"Build Tetris" --force'],
		["switch --force abc123", "switch", "--force abc123"],
		["revise goal", "revise", "goal"],
		["revise GOAL", "revise", "GOAL"],
		["revise constraints", "revise", "constraints"],
		['new "Build Tetris"', "new", '"Build Tetris"'],
		["new 'X'", "new", "'X'"],
		['abandon "no longer needed"', "abandon", '"no longer needed"'],
		['one-shot "fix the build"', "one-shot", '"fix the build"'],
	])("returns a hint for the V1 argument form %j", (input, word, args) => {
		expect(parseFermentV2Command(input)).toEqual({ action: "legacy-hint", word, args })
	})

	it.each([
		"revise the README goal",
		"new Build Tetris",
		"abandon this approach",
		"delete --tokens 5k",
		'switch to "pnpm" now',
	])("still starts a run for text that only looks like a V1 form: %j", (input) => {
		expect(parseFermentV2Command(input).action).toBe("set")
	})

	it.each([
		"list all todos in the repo",
		"exit early when the build fails",
		"new landing page",
		"delete dead code",
		"switch the CI to pnpm",
		"revise the README",
		"export metrics to CSV",
		"one-shot fix for the flaky test",
	])("still starts a run when a legacy word has more text: %j", (input) => {
		expect(parseFermentV2Command(input)).toEqual({ action: "set", objective: input })
	})

	it("still starts a run when a legacy word has a token budget", () => {
		expect(parseFermentV2Command("list --tokens 5k")).toEqual({ action: "set", objective: "list", tokenBudget: 5_000 })
	})

	it("does not catch words that only look like legacy words", () => {
		expect(parseFermentV2Command("lists")).toEqual({ action: "set", objective: "lists" })
		expect(parseFermentV2Command("oneshot")).toEqual({ action: "set", objective: "oneshot" })
		expect(parseFermentV2Command("ship")).toEqual({ action: "set", objective: "ship" })
	})

	it("keeps the V2 words, including the ones V1 also had", () => {
		expect(parseFermentV2Command("pause")).toEqual({ action: "pause" })
		expect(parseFermentV2Command("RESUME")).toEqual({ action: "resume" })
		expect(parseFermentV2Command("clear")).toEqual({ action: "clear" })
		expect(parseFermentV2Command("edit")).toEqual({ action: "edit" })
	})

	it("matches the legacy subcommands except the V2 words", () => {
		const legacyLabels = (getFermentArgumentCompletions("") ?? []).map((entry) => entry.label)
		const v2Words: readonly string[] = FERMENT_V2_COMMAND_COMPLETIONS
		expect([...FERMENT_LEGACY_WORDS].sort()).toEqual(legacyLabels.filter((label) => !v2Words.includes(label)).sort())
	})

	it.each([...FERMENT_LEGACY_WORDS])("names a word the legacy parser knows: %s", (word) => {
		const withArgument = ["switch", "delete", "revise"].includes(word) ? `${word} goal` : word
		expect(parseFermentCommand(withArgument).type).not.toBe("unknown")
	})

	describe("hint text", () => {
		let agentDir: string

		beforeEach(() => {
			agentDir = mkdtempSync(join(tmpdir(), "ferment-v2-legacy-hint-"))
			process.env.KIMCHI_CODING_AGENT_DIR = agentDir
			Reflect.deleteProperty(process.env, "KIMCHI_ENABLE_RESOURCES")
			resetOrgPolicyForTests()
		})

		afterEach(() => {
			acpHost.value = false
			resetOrgPolicyForTests()
			resetFermentLegacyLoadedForTests()
			Reflect.deleteProperty(process.env, "KIMCHI_CODING_AGENT_DIR")
			rmSync(agentDir, { recursive: true, force: true })
		})

		it("points to /ferment-legacy when legacy is on", () => {
			setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
			markFermentLegacyLoaded()
			expect(formatFermentLegacyWordHint("list")).toBe(
				[
					"/ferment list is a legacy Ferment command. Use /ferment-legacy list.",
					'To start a Ferment with "list" as the objective, write a longer objective.',
				].join("\n"),
			)
		})

		it("shows the argument for legacy words that need one", () => {
			setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
			markFermentLegacyLoaded()
			expect(formatFermentLegacyWordHint("switch")).toContain("Use /ferment-legacy switch <id-or-name>.")
			expect(formatFermentLegacyWordHint("delete")).toContain("Use /ferment-legacy delete <id-or-name>.")
			expect(formatFermentLegacyWordHint("revise")).toContain("Use /ferment-legacy revise goal|criteria|constraints.")
		})

		it("says how to turn legacy on when it is off", () => {
			expect(formatFermentLegacyWordHint("exit")).toBe(
				[
					"/ferment exit is a legacy Ferment command. Use /ferment-legacy exit.",
					"/ferment-legacy exit needs the legacy Ferment, which is off. Turn it on with: kimchi resources enable extensions.ferment-legacy\nThen restart kimchi to load it.",
					"To stop the current Ferment, use /ferment pause or /ferment clear.",
					'To start a Ferment with "exit" as the objective, write a longer objective.',
				].join("\n"),
			)
		})

		it("says to restart when legacy is on but not loaded", () => {
			setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
			expect(formatFermentLegacyWordHint("list")).toContain("It is on now, but it loads only when kimchi starts.")
		})

		it("shows the typed arguments", () => {
			setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
			markFermentLegacyLoaded()
			expect(formatFermentLegacyWordHint("delete", "old-auth")).toBe(
				[
					"/ferment delete old-auth is a legacy Ferment command. Use /ferment-legacy delete old-auth.",
					"To start a Ferment with this as the objective, rephrase it as a sentence.",
				].join("\n"),
			)
		})

		it.each(["exit", "abandon"] as const)("points to pause and clear for %s", (word) => {
			setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
			markFermentLegacyLoaded()
			expect(formatFermentLegacyWordHint(word)).toContain(
				"To stop the current Ferment, use /ferment pause or /ferment clear.",
			)
		})

		it("does not add the stop line for list", () => {
			setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
			markFermentLegacyLoaded()
			expect(formatFermentLegacyWordHint("list")).not.toContain("To stop the current Ferment")
		})

		// Legacy Ferment never loads over ACP, so the hint must not point to it.
		describe("over ACP", () => {
			beforeEach(() => {
				acpHost.value = true
			})

			it("says legacy is not available instead of pointing to /ferment-legacy", () => {
				expect(formatFermentLegacyWordHint("list")).toBe(
					[
						"/ferment list is a legacy Ferment command. Legacy Ferment is not available in this client.",
						'To start a Ferment with "list" as the objective, write a longer objective.',
					].join("\n"),
				)
			})

			it("does not mention /ferment-legacy even when legacy is on and loaded", () => {
				setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
				markFermentLegacyLoaded()
				const hint = formatFermentLegacyWordHint("switch")
				expect(hint).not.toContain("/ferment-legacy")
				expect(hint).not.toContain("kimchi resources enable")
			})

			it("shows the typed arguments", () => {
				expect(formatFermentLegacyWordHint("delete", "old-auth")).toBe(
					[
						"/ferment delete old-auth is a legacy Ferment command. Legacy Ferment is not available in this client.",
						"To start a Ferment with this as the objective, rephrase it as a sentence.",
					].join("\n"),
				)
			})

			it.each(["exit", "abandon"] as const)("still points to pause and clear for %s", (word) => {
				expect(formatFermentLegacyWordHint(word)).toContain(
					"To stop the current Ferment, use /ferment pause or /ferment clear.",
				)
			})
		})

		it("names the org policy when the organization turned legacy off", async () => {
			setResourceOverride(FERMENT_LEGACY_RESOURCE_ID, true)
			await setOrgPolicyForTests({ resources: { [FERMENT_LEGACY_RESOURCE_ID]: "FORCE_OFF" } })
			const hint = formatFermentLegacyWordHint("auto")
			expect(hint).toContain("Use /ferment-legacy auto.")
			expect(hint).toContain("which your organization turned off")
			expect(hint).not.toContain("kimchi resources enable")
		})

		it("names the org policy when the organization turned Ferment off", async () => {
			await setOrgPolicyForTests({ resources: { "extensions.ferment": "FORCE_OFF" } })
			const hint = formatFermentLegacyWordHint("list")
			expect(hint).toContain("which your organization turned off (extensions.ferment")
			expect(hint).not.toContain("kimchi resources enable")
		})
	})
})
