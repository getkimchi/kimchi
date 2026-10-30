import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** Sentinel the mocked clack prompts return for Esc/Ctrl-C, matching isCancel. */
const CLACK_CANCEL = Symbol("clack-cancel")

vi.mock("@clack/prompts", () => ({
	select: vi.fn(),
	password: vi.fn(),
	text: vi.fn(),
	confirm: vi.fn(),
	multiselect: vi.fn(),
	isCancel: (value: unknown) => value === CLACK_CANCEL,
}))
vi.mock("open", () => ({ default: vi.fn().mockResolvedValue(undefined) }))

import { password as clackPassword, select as clackSelect, text as clackText } from "@clack/prompts"
import open from "open"

/** The real `open` types its return as ChildProcess; the mock is a loose vi.fn. */
const openMock = open as unknown as ReturnType<typeof vi.fn>

import {
	KIMCHI_ACCOUNT_LABEL,
	KIMCHI_API_KEY_LABEL,
	KIMCHI_SSO_LABEL,
	LOGIN_METHOD_SELECTOR_TITLE,
	REGION_SELECTOR_TITLE,
} from "../extensions/login/flow.js"
import { REGIONS } from "../regions.js"
import {
	createCliSsoCallbacks,
	promptKimchiApiKey,
	promptKimchiEndpoint,
	promptLoginMethod,
	promptLoginRegion,
	promptSelfHostedConsoleEndpoints,
} from "./login-prompts.js"

// The wizard wrappers classify a clack cancel from the last keypress on stdin:
// emitting escape before resolving the sentinel reads as Esc ("back"), ctrl+c as Ctrl-C ("cancel").
function pressEscape() {
	process.stdin.emit("keypress", undefined, { name: "escape" })
	return CLACK_CANCEL
}
function pressCtrlC() {
	process.stdin.emit("keypress", undefined, { name: "c", ctrl: true })
	return CLACK_CANCEL
}

const DISCOVERED_ENDPOINTS = {
	api: "https://kimchi.example.com",
	console: "https://kimchi.example.com",
	llm: "https://llm.example.com",
}

beforeEach(() => {
	vi.clearAllMocks()
	// Module-factory mocks lose their implementations under clearAllMocks; re-arm.
	openMock.mockResolvedValue(undefined)
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

describe("promptLoginMethod", () => {
	it("offers SSO first, then account and API key, with the /login selector title", async () => {
		vi.mocked(clackSelect).mockResolvedValueOnce("sso")

		const outcome = await promptLoginMethod(true)

		expect(outcome).toEqual({ kind: "next", value: "sso" })
		const args = vi.mocked(clackSelect).mock.calls[0]?.[0]
		expect(args?.message).toBe(LOGIN_METHOD_SELECTOR_TITLE)
		expect(args?.options).toEqual([
			{ value: "sso", label: KIMCHI_SSO_LABEL },
			{ value: "account", label: KIMCHI_ACCOUNT_LABEL },
			{ value: "api-key", label: KIMCHI_API_KEY_LABEL },
		])
	})

	it("omits SSO when no region has an OAuth tenant", async () => {
		vi.mocked(clackSelect).mockResolvedValueOnce("account")

		await promptLoginMethod(false)

		const options = vi.mocked(clackSelect).mock.calls[0]?.[0]?.options
		expect(options?.map((option) => option.value)).toEqual(["account", "api-key"])
	})

	it("never offers the subscription method (TUI-only)", async () => {
		vi.mocked(clackSelect).mockResolvedValueOnce("account")

		await promptLoginMethod(true)

		const options = vi.mocked(clackSelect).mock.calls[0]?.[0]?.options
		expect(options?.map((option) => option.value)).not.toContain("subscription")
	})

	it("maps Esc to back and Ctrl-C to cancel", async () => {
		vi.mocked(clackSelect).mockImplementationOnce(async () => pressEscape())
		expect(await promptLoginMethod(true)).toEqual({ kind: "back" })

		vi.mocked(clackSelect).mockImplementationOnce(async () => pressCtrlC())
		expect(await promptLoginMethod(true)).toEqual({ kind: "cancel" })
	})
})

describe("promptLoginRegion", () => {
	it("marks the current region, preselects it, and uses the /login selector title", async () => {
		vi.mocked(clackSelect).mockResolvedValueOnce("eu")

		const outcome = await promptLoginRegion([REGIONS.us, REGIONS.eu], "us")

		expect(outcome).toEqual({ kind: "next", value: "eu" })
		const args = vi.mocked(clackSelect).mock.calls[0]?.[0]
		expect(args?.message).toBe(REGION_SELECTOR_TITLE)
		expect(args?.initialValue).toBe("us")
		expect(args?.options).toEqual([
			{ value: "us", label: "United States — current" },
			{ value: "eu", label: "Europe" },
		])
	})

	it("maps Esc to back", async () => {
		vi.mocked(clackSelect).mockImplementationOnce(async () => pressEscape())
		expect(await promptLoginRegion([REGIONS.us], "us")).toEqual({ kind: "back" })
	})
})

describe("promptKimchiApiKey", () => {
	it("returns the entered key", async () => {
		vi.mocked(clackPassword).mockResolvedValueOnce("castai_v1_secret")

		expect(await promptKimchiApiKey()).toEqual({ kind: "next", value: "castai_v1_secret" })
	})

	it("rejects an empty key via clack validation", async () => {
		vi.mocked(clackPassword).mockResolvedValueOnce("castai_v1_secret")

		await promptKimchiApiKey()

		const validate = vi.mocked(clackPassword).mock.calls[0]?.[0]?.validate
		expect(validate?.("")).toBe("Kimchi API key is required.")
		expect(validate?.("   ")).toBe("Kimchi API key is required.")
		expect(validate?.("castai_v1_secret")).toBeUndefined()
	})
})

describe("promptKimchiEndpoint", () => {
	it("keeps the region default on an empty answer", async () => {
		vi.mocked(clackText).mockResolvedValueOnce("")

		expect(await promptKimchiEndpoint("https://default.example.com")).toEqual({
			kind: "next",
			value: "https://default.example.com",
		})
	})

	it("trims a custom endpoint", async () => {
		vi.mocked(clackText).mockResolvedValueOnce("  https://custom.example.com  ")

		expect(await promptKimchiEndpoint("https://default.example.com")).toEqual({
			kind: "next",
			value: "https://custom.example.com",
		})
	})

	it("maps Esc to back", async () => {
		vi.mocked(clackText).mockImplementationOnce(async () => pressEscape())
		expect(await promptKimchiEndpoint("https://default.example.com")).toEqual({ kind: "back" })
	})
})

describe("promptSelfHostedConsoleEndpoints", () => {
	it("returns discovered endpoints after the URL prompt", async () => {
		vi.mocked(clackText).mockResolvedValueOnce(" https://kimchi.example.com/ ")
		const discoverEndpoints = vi.fn().mockResolvedValue({ status: "discovered", endpoints: DISCOVERED_ENDPOINTS })

		const outcome = await promptSelfHostedConsoleEndpoints(undefined, { discoverEndpoints })

		expect(outcome).toEqual({ kind: "next", value: DISCOVERED_ENDPOINTS })
		expect(discoverEndpoints).toHaveBeenCalledWith("https://kimchi.example.com")
	})

	it("maps Esc to back without touching discovery", async () => {
		vi.mocked(clackText).mockImplementationOnce(async () => pressEscape())
		const discoverEndpoints = vi.fn()

		const outcome = await promptSelfHostedConsoleEndpoints(undefined, { discoverEndpoints })

		expect(outcome).toEqual({ kind: "back" })
		expect(discoverEndpoints).not.toHaveBeenCalled()
	})

	it("maps Ctrl-C to cancel without touching discovery", async () => {
		vi.mocked(clackText).mockImplementationOnce(async () => pressCtrlC())
		const discoverEndpoints = vi.fn()

		const outcome = await promptSelfHostedConsoleEndpoints(undefined, { discoverEndpoints })

		expect(outcome).toEqual({ kind: "cancel" })
		expect(discoverEndpoints).not.toHaveBeenCalled()
	})
})

describe("createCliSsoCallbacks", () => {
	function make() {
		const controller = new AbortController()
		return { controller, callbacks: createCliSsoCallbacks(controller) }
	}

	it("passes the shared signal through to the OAuth flow", () => {
		const { controller, callbacks } = make()
		expect(callbacks.signal).toBe(controller.signal)
	})

	it("prints the authorize URL and instructions, then opens the browser", async () => {
		const { callbacks } = make()

		callbacks.onAuth({ url: "https://login.kimchi.dev/authorize?x=1", instructions: "Complete sign-in." })
		await vi.waitFor(() => expect(openMock).toHaveBeenCalledWith("https://login.kimchi.dev/authorize?x=1"))

		expect(console.log).toHaveBeenCalledWith("Complete sign-in.")
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("https://login.kimchi.dev/authorize?x=1"))
	})

	it("skips the browser open under the e2e seam", async () => {
		vi.stubEnv("KIMCHI_E2E_FAKE_BROWSER_OPEN", "1")
		const { callbacks } = make()

		callbacks.onAuth({ url: "https://login.kimchi.dev/authorize?x=1" })
		await Promise.resolve()

		expect(openMock).not.toHaveBeenCalled()
	})

	it("logs progress messages", () => {
		const { callbacks } = make()
		callbacks.onProgress?.("Fetching your organizations…")
		expect(console.log).toHaveBeenCalledWith("Fetching your organizations…")
	})

	it("resolves onSelect with the picked option id", async () => {
		const { callbacks } = make()
		vi.mocked(clackSelect).mockResolvedValueOnce("org-1")

		await expect(
			callbacks.onSelect?.({ message: "Select organization:", options: [{ id: "org-1", label: "Acme" }] }),
		).resolves.toBe("org-1")
	})

	it("resolves onSelect to undefined on Esc (the SSO flow maps that to cancelled)", async () => {
		const { controller, callbacks } = make()
		vi.mocked(clackSelect).mockImplementationOnce(async () => pressEscape())

		await expect(
			callbacks.onSelect?.({ message: "Select organization:", options: [{ id: "org-1", label: "Acme" }] }),
		).resolves.toBeUndefined()
		expect(controller.signal.aborted).toBe(false)
	})

	it("aborts the shared controller and rejects on a cancelled manual-code prompt", async () => {
		const { controller, callbacks } = make()
		vi.mocked(clackText).mockImplementationOnce(async () => pressEscape())

		await expect(callbacks.onManualCodeInput?.()).rejects.toThrow("Login cancelled")
		expect(controller.signal.aborted).toBe(true)
	})

	it("returns the pasted redirect URL from the manual-code prompt", async () => {
		const { callbacks } = make()
		vi.mocked(clackText).mockResolvedValueOnce("http://localhost:8765/callback?code=abc&state=s")

		await expect(callbacks.onManualCodeInput?.()).resolves.toBe("http://localhost:8765/callback?code=abc&state=s")
	})
})
