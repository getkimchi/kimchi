import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WizardState } from "../state.js"

// Hoisted mocks so they are installed before the module under test is loaded.
const validateApiKeyMock = vi.hoisted(() => vi.fn())
const authenticateViaBrowserMock = vi.hoisted(() => vi.fn())
const writeApiKeyMock = vi.hoisted(() => vi.fn())
const readApiKeyFromConfigFileMock = vi.hoisted(() => vi.fn())
const passwordMock = vi.hoisted(() => vi.fn())
const confirmMock = vi.hoisted(() => vi.fn())

vi.mock("../../auth/validator.js", () => ({ validateApiKey: validateApiKeyMock }))
vi.mock("../../cli-auth/index.js", () => ({ authenticateViaBrowser: authenticateViaBrowserMock }))
vi.mock("../../config.js", () => ({
	readApiKeyFromConfigFile: readApiKeyFromConfigFileMock,
	writeApiKey: writeApiKeyMock,
}))
vi.mock("../prompt.js", () => ({
	password: passwordMock,
	confirm: confirmMock,
}))

const { runAuthStep } = await import("./auth.js")

describe("runAuthStep", () => {
	let state: WizardState
	let savedApiKey: string | undefined

	beforeEach(() => {
		state = {
			apiKey: "",
			mode: "override",
			scope: "global",
			selectedTools: [],
			telemetryEnabled: false,
			back: false,
			cancelled: false,
		}
		savedApiKey = process.env.KIMCHI_API_KEY
		process.env.KIMCHI_API_KEY = ""
		validateApiKeyMock.mockReset()
		authenticateViaBrowserMock.mockReset()
		writeApiKeyMock.mockReset()
		readApiKeyFromConfigFileMock.mockReset()
		passwordMock.mockReset()
		confirmMock.mockReset()
		vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		if (savedApiKey !== undefined) process.env.KIMCHI_API_KEY = savedApiKey
		// biome-ignore lint/performance/noDelete: env var must be deleted, not set to "undefined"
		else delete process.env.KIMCHI_API_KEY
	})

	it("validates and saves a pasted API key", async () => {
		readApiKeyFromConfigFileMock.mockReturnValue(undefined)
		passwordMock.mockResolvedValue({ kind: "next", value: "paste-key-123" })
		validateApiKeyMock.mockResolvedValue({ valid: true })

		await runAuthStep(state, { backable: false })

		expect(validateApiKeyMock).toHaveBeenCalledWith("paste-key-123")
		expect(state.apiKey).toBe("paste-key-123")
		expect(writeApiKeyMock).toHaveBeenCalledWith("paste-key-123")
	})

	it("triggers browser auth when the user presses Enter (empty input)", async () => {
		readApiKeyFromConfigFileMock.mockReturnValue(undefined)
		passwordMock.mockResolvedValue({ kind: "next", value: "" })
		authenticateViaBrowserMock.mockResolvedValue({ token: "browser-token-456" })
		validateApiKeyMock.mockResolvedValue({ valid: true })

		await runAuthStep(state, { backable: false })

		expect(authenticateViaBrowserMock).toHaveBeenCalledTimes(1)
		expect(validateApiKeyMock).toHaveBeenCalledTimes(0)
		expect(state.apiKey).toBe("browser-token-456")
		expect(writeApiKeyMock).toHaveBeenCalledWith("browser-token-456")
	})

	it("retries when browser auth fails and then asks for manual input", async () => {
		readApiKeyFromConfigFileMock.mockReturnValue(undefined)
		passwordMock
			.mockResolvedValueOnce({ kind: "next", value: "" })
			.mockResolvedValueOnce({ kind: "next", value: "fallback-key-789" })
		authenticateViaBrowserMock.mockRejectedValue(new Error("Browser refused"))
		validateApiKeyMock.mockResolvedValue({ valid: true })

		await runAuthStep(state, { backable: false })

		expect(authenticateViaBrowserMock).toHaveBeenCalledTimes(1)
		// After browser failure it loops back and prompts again
		expect(passwordMock).toHaveBeenCalledTimes(2)
		expect(validateApiKeyMock).toHaveBeenCalledWith("fallback-key-789")
		expect(state.apiKey).toBe("fallback-key-789")
	})

	it("uses the saved key without prompting when one exists and user confirms", async () => {
		readApiKeyFromConfigFileMock.mockReturnValue("saved-key")
		confirmMock.mockResolvedValue({ kind: "next", value: true })
		validateApiKeyMock.mockResolvedValue({ valid: true })

		await runAuthStep(state, { backable: true })

		expect(confirmMock).toHaveBeenCalledTimes(1)
		expect(validateApiKeyMock).toHaveBeenCalledWith("saved-key")
		expect(passwordMock).not.toHaveBeenCalled()
		expect(state.apiKey).toBe("saved-key")
	})

	it("prompts for a new key when the saved key is rejected and user opts to replace", async () => {
		readApiKeyFromConfigFileMock.mockReturnValue("saved-key")
		confirmMock.mockResolvedValue({ kind: "next", value: false }) // user says "don't keep it"
		passwordMock.mockResolvedValue({ kind: "next", value: "new-key-abc" })
		validateApiKeyMock.mockResolvedValue({ valid: true })

		await runAuthStep(state, { backable: true })

		expect(confirmMock).toHaveBeenCalledTimes(1)
		expect(passwordMock).toHaveBeenCalledTimes(1)
		expect(validateApiKeyMock).toHaveBeenCalledWith("new-key-abc")
		expect(state.apiKey).toBe("new-key-abc")
	})

	it("sets state.back when user presses Esc in the prompt", async () => {
		readApiKeyFromConfigFileMock.mockReturnValue(undefined)
		passwordMock.mockResolvedValue({ kind: "back" })

		await runAuthStep(state, { backable: true })

		expect(state.back).toBe(true)
		expect(authenticateViaBrowserMock).not.toHaveBeenCalled()
	})

	it("sets state.cancelled when user presses Ctrl-C", async () => {
		readApiKeyFromConfigFileMock.mockReturnValue(undefined)
		passwordMock.mockResolvedValue({ kind: "cancel" })

		await runAuthStep(state, { backable: true })

		expect(state.cancelled).toBe(true)
	})
})
