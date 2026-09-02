import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyPostMainInfrastructureExitPolicy } from "./cli-infrastructure-exit.js"
import { type InfrastructureFailure, KIMCHI_INFRA_ERROR_EXIT_CODE } from "./infrastructure-error.js"
import { classifyLLMGatewayError } from "./llm-gateway-error.js"

function createFailure(errorMessage: string, overrides: Partial<InfrastructureFailure> = {}): InfrastructureFailure {
	const error = classifyLLMGatewayError(errorMessage)
	if (!error) throw new Error(`Expected test message to classify: ${errorMessage}`)
	return {
		error,
		consecutiveInfraErrors: 1,
		...overrides,
	}
}

describe("post-main CLI infrastructure exit policy", () => {
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

	it("stamps the infra marker and exits immediately for failed infra runs", () => {
		process.exitCode = 1
		const exitProcess = vi.fn()

		const applied = applyPostMainInfrastructureExitPolicy(
			createFailure("ERR_SOCKET_CLOSED", {
				consecutiveInfraErrors: 2,
				sessionPath: "/tmp/session.jsonl",
			}),
			exitProcess,
		)

		expect(applied).toBe(true)
		expect(process.exitCode).toBe(KIMCHI_INFRA_ERROR_EXIT_CODE)
		expect(exitProcess).toHaveBeenCalledWith(KIMCHI_INFRA_ERROR_EXIT_CODE)
		expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("KIMCHI_INFRA_ERROR")
	})

	it("does not force exit when the run did not fail or no infra failure was tracked", () => {
		const exitProcess = vi.fn()

		process.exitCode = undefined
		expect(
			applyPostMainInfrastructureExitPolicy(
				createFailure("ERR_SOCKET_CLOSED", { consecutiveInfraErrors: 1 }),
				exitProcess,
			),
		).toBe(false)

		process.exitCode = 1
		expect(applyPostMainInfrastructureExitPolicy(undefined, exitProcess)).toBe(false)
		expect(exitProcess).not.toHaveBeenCalled()
	})
})
