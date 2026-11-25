import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyPostMainRunOutcomeExitPolicy } from "./cli-run-outcome-exit.js"
import { KIMCHI_INFRA_ERROR_EXIT_CODE } from "./infrastructure-error.js"
import { KIMCHI_NO_PROMPT_EXIT_CODE, KIMCHI_NO_RESULT_EXIT_CODE, type RunOutcomeClassification } from "./run-outcome.js"

const NO_PROMPT: RunOutcomeClassification = { kind: "no-prompt" }
const NO_RESULT: RunOutcomeClassification = { kind: "no-result", lastEvent: { kind: "none" } }

describe("post-main run outcome exit policy", () => {
	let previousExitCode: typeof process.exitCode
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		previousExitCode = process.exitCode
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		process.exitCode = previousExitCode
		consoleErrorSpy.mockRestore()
	})

	it("leaves an unset successful outcome unchanged without stderr", () => {
		process.exitCode = undefined
		expect(applyPostMainRunOutcomeExitPolicy({ kind: "ok" })).toBe(false)
		expect(process.exitCode).toBeUndefined()
		expect(consoleErrorSpy).not.toHaveBeenCalled()
	})

	it("turns no-prompt into exit code 2 with its prefix", () => {
		process.exitCode = undefined
		expect(applyPostMainRunOutcomeExitPolicy(NO_PROMPT)).toBe(true)
		expect(process.exitCode).toBe(KIMCHI_NO_PROMPT_EXIT_CODE)
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
		expect(String(consoleErrorSpy.mock.calls[0]?.[0]).startsWith("KIMCHI_NO_PROMPT:")).toBe(true)
	})

	it("turns no-result into exit code 3 with its prefix", () => {
		process.exitCode = undefined
		expect(applyPostMainRunOutcomeExitPolicy(NO_RESULT)).toBe(true)
		expect(process.exitCode).toBe(KIMCHI_NO_RESULT_EXIT_CODE)
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
		expect(String(consoleErrorSpy.mock.calls[0]?.[0]).startsWith("KIMCHI_NO_RESULT:")).toBe(true)
	})

	it("replaces an explicit zero for no-result", () => {
		process.exitCode = 0
		expect(applyPostMainRunOutcomeExitPolicy(NO_RESULT)).toBe(true)
		expect(process.exitCode).toBe(KIMCHI_NO_RESULT_EXIT_CODE)
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
	})

	it("preserves model error exit code 1 without another message", () => {
		process.exitCode = 1
		expect(applyPostMainRunOutcomeExitPolicy(NO_RESULT)).toBe(false)
		expect(process.exitCode).toBe(1)
		expect(consoleErrorSpy).not.toHaveBeenCalled()
	})

	it("preserves infrastructure exit code 74 without another message", () => {
		process.exitCode = KIMCHI_INFRA_ERROR_EXIT_CODE
		expect(applyPostMainRunOutcomeExitPolicy(NO_RESULT)).toBe(false)
		expect(process.exitCode).toBe(74)
		expect(consoleErrorSpy).not.toHaveBeenCalled()
	})
})
