import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// login.ts pulls in login-prompts → setup-wizard/prompt, which imports the
// full clack surface; the module mock must cover every named import.
vi.mock("@clack/prompts", () => ({
	spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
	select: vi.fn(),
	password: vi.fn(),
	text: vi.fn(),
	confirm: vi.fn(),
	multiselect: vi.fn(),
	isCancel: () => false,
}))
vi.mock("../cli-auth/index.js", () => ({ authenticateViaBrowser: vi.fn() }))
vi.mock("../cli-auth/oauth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../cli-auth/oauth.js")>()
	return { ...actual, loginWithCastAiOauth: vi.fn() }
})
vi.mock("../pi-auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../pi-auth.js")>()
	return { ...actual, syncOAuthCredentialToKimchiProviders: vi.fn() }
})
vi.mock("../self-hosted-discovery.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../self-hosted-discovery.js")>()
	return { ...actual, fetchSelfHostedEndpoints: vi.fn() }
})
// Flow finalization functions are mocked here (selector-path plumbing); the
// finalization itself is asserted end-to-end in login-parity.test.ts.
vi.mock("../extensions/login/flow.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../extensions/login/flow.js")>()
	return {
		...actual,
		performKimchiBrowserLogin: vi.fn(),
		performKimchiApiKeyLogin: vi.fn(),
		completeKimchiSsoLogin: vi.fn(),
		// Provider OAuth wiring is finalization-internal; plumbing tests mock it
		// away (the real one needs kimchiSsoExtensionOAuth from cli-auth/oauth.js).
		installKimchiOAuth: vi.fn(),
	}
})
vi.mock("./login-prompts.js", () => ({
	promptLoginMethod: vi.fn(),
	promptLoginRegion: vi.fn(),
	promptSelfHostedConsoleEndpoints: vi.fn(),
	promptKimchiApiKey: vi.fn(),
	promptKimchiEndpoint: vi.fn(),
	createCliSsoCallbacks: vi.fn(() => ({})),
}))

import { authenticateViaBrowser } from "../cli-auth/index.js"
import { loginWithCastAiOauth } from "../cli-auth/oauth.js"
import * as config from "../config.js"
import { setExperimentalFeaturesEnabled } from "../extensions/experimental.js"
import {
	completeKimchiSsoLogin,
	performKimchiApiKeyLogin,
	performKimchiBrowserLogin,
} from "../extensions/login/flow.js"
import { fetchSelfHostedEndpoints } from "../self-hosted-discovery.js"
import { runLogin } from "./login.js"
import {
	promptKimchiApiKey,
	promptKimchiEndpoint,
	promptLoginMethod,
	promptLoginRegion,
	promptSelfHostedConsoleEndpoints,
} from "./login-prompts.js"

const DISCOVERED_ENDPOINTS = {
	api: "https://kimchi.example.com",
	console: "https://kimchi.example.com",
	llm: "https://llm.example.com",
}

const INTERACTIVE = { isInteractive: () => true }

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv("KIMCHI_CONFIG_PATH", "/tmp/kimchi-login-command-test/config.json")
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "/tmp/kimchi-login-command-test/agent")
	vi.stubEnv("KIMCHI_API_KEY", undefined)
	vi.spyOn(config, "writeApiKey").mockImplementation(() => {})
	vi.mocked(authenticateViaBrowser).mockResolvedValue({ token: "new-key" })
	vi.mocked(fetchSelfHostedEndpoints).mockResolvedValue({ status: "discovered", endpoints: DISCOVERED_ENDPOINTS })
	vi.mocked(performKimchiBrowserLogin).mockResolvedValue(true)
	vi.mocked(performKimchiApiKeyLogin).mockResolvedValue(true)
	vi.mocked(completeKimchiSsoLogin).mockResolvedValue(true)
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
	vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// Legacy path (non-interactive stdin) — behavior unchanged.
// ---------------------------------------------------------------------------

it.each(["", "new-key", "old-key"])("saves login and warns only on mismatch (%s)", async (envKey) => {
	vi.stubEnv("KIMCHI_API_KEY", envKey)
	expect(await runLogin([])).toBe(0)
	expect(config.writeApiKey).toHaveBeenCalledWith("new-key")
	expect(process.env.KIMCHI_API_KEY).toBe(envKey)
	if (envKey === "old-key") {
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Using the environment key."))
		expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("unset"))
	} else {
		expect(console.warn).not.toHaveBeenCalled()
	}
})

it("does not announce a saved login when saving fails", async () => {
	vi.stubEnv("KIMCHI_API_KEY", "old-key")
	vi.mocked(config.writeApiKey).mockImplementation(() => {
		throw new Error("disk full")
	})
	expect(await runLogin([])).toBe(1)
	expect(console.warn).not.toHaveBeenCalled()
})

// ---------------------------------------------------------------------------
// kimchi login <console-url> — self-hosted shortcut (discovery + full finalization)
// ---------------------------------------------------------------------------

describe("kimchi login <console-url> (self-hosted flow)", () => {
	it("discovers endpoints and runs the finalized self-hosted account login", async () => {
		expect(await runLogin([" https://kimchi.example.com/ "])).toBe(0)

		// Discovery runs against the normalized console URL.
		expect(fetchSelfHostedEndpoints).toHaveBeenCalledWith("https://kimchi.example.com")
		// The finalized account login runs for the self-hosted region with the
		// discovered endpoints (writeApiKey with region + endpoints happens
		// inside performKimchiBrowserLogin — covered by the parity suite).
		expect(performKimchiBrowserLogin).toHaveBeenCalledWith(expect.anything(), {
			region: "self-hosted",
			selfHostedEndpoints: DISCOVERED_ENDPOINTS,
		})
	})

	it("fails when the install does not serve the discovery document", async () => {
		vi.mocked(fetchSelfHostedEndpoints).mockResolvedValue({
			status: "unavailable",
			cause: "not-found",
			reason: "no discovery document at /env/endpoints.json (HTTP 404)",
		})

		expect(await runLogin(["https://kimchi.example.com"])).toBe(1)

		expect(console.error).toHaveBeenCalledWith(
			"Endpoint discovery failed: no discovery document at /env/endpoints.json (HTTP 404). A self-hosted install must serve /env/endpoints.json.",
		)
		expect(performKimchiBrowserLogin).not.toHaveBeenCalled()
	})

	it("rejects an invalid console URL without touching auth", async () => {
		expect(await runLogin(["not a url"])).toBe(1)

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Invalid console URL"))
		expect(fetchSelfHostedEndpoints).not.toHaveBeenCalled()
		expect(performKimchiBrowserLogin).not.toHaveBeenCalled()
	})

	it("rejects more than one URL argument", async () => {
		expect(await runLogin(["https://kimchi.example.com", "https://other.example.com"])).toBe(1)

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("at most one URL"))
		expect(authenticateViaBrowser).not.toHaveBeenCalled()
	})

	it("propagates a browser-login failure as exit code 1", async () => {
		vi.mocked(performKimchiBrowserLogin).mockResolvedValue(false)

		expect(await runLogin(["https://kimchi.example.com"])).toBe(1)
	})
})

// ---------------------------------------------------------------------------
// Interactive path (/login parity)
// ---------------------------------------------------------------------------

describe("interactive kimchi login", () => {
	// EU region/SSO-tenant selection is gated behind experimental features.
	beforeEach(() => setExperimentalFeaturesEnabled(true))
	afterEach(() => setExperimentalFeaturesEnabled(false))

	it("Exits 0 with a notice when Esc is pressed at the method selector", async () => {
		vi.mocked(promptLoginMethod).mockResolvedValue({ kind: "back" })

		expect(await runLogin([], INTERACTIVE)).toBe(0)

		expect(console.log).toHaveBeenCalledWith("Login cancelled.")
		expect(performKimchiBrowserLogin).not.toHaveBeenCalled()
	})

	it("exits 130 when Ctrl-C is pressed at the method selector", async () => {
		vi.mocked(promptLoginMethod).mockResolvedValue({ kind: "cancel" })

		expect(await runLogin([], INTERACTIVE)).toBe(130)
		expect(console.log).toHaveBeenCalledWith("Login cancelled.")
	})

	it("runs the account login for the picked region", async () => {
		vi.mocked(promptLoginMethod).mockResolvedValue({ kind: "next", value: "account" })
		vi.mocked(promptLoginRegion).mockResolvedValue({ kind: "next", value: "eu" })

		expect(await runLogin([], INTERACTIVE)).toBe(0)

		expect(performKimchiBrowserLogin).toHaveBeenCalledWith(expect.anything(), {
			region: "eu",
			selfHostedEndpoints: undefined,
		})
	})

	it("returns to the method selector when Esc is pressed at the region selector", async () => {
		vi.mocked(promptLoginMethod)
			.mockResolvedValueOnce({ kind: "next", value: "account" })
			.mockResolvedValueOnce({ kind: "back" })
		vi.mocked(promptLoginRegion).mockResolvedValue({ kind: "back" })

		expect(await runLogin([], INTERACTIVE)).toBe(0)

		expect(promptLoginMethod).toHaveBeenCalledTimes(2)
		expect(performKimchiBrowserLogin).not.toHaveBeenCalled()
	})

	it("runs the API-key login with the region default endpoint", async () => {
		vi.mocked(promptLoginMethod).mockResolvedValue({ kind: "next", value: "api-key" })
		vi.mocked(promptLoginRegion).mockResolvedValue({ kind: "next", value: "us" })
		vi.mocked(promptKimchiApiKey).mockResolvedValue({ kind: "next", value: "castai_v1_key" })
		vi.mocked(promptKimchiEndpoint).mockResolvedValue({ kind: "next", value: "https://api.us.kimchi.dev" })

		expect(await runLogin([], INTERACTIVE)).toBe(0)

		expect(performKimchiApiKeyLogin).toHaveBeenCalledWith(expect.anything(), {
			apiKey: "castai_v1_key",
			endpoint: "https://api.us.kimchi.dev",
			region: "us",
			selfHostedEndpoints: undefined,
		})
	})

	it("skips the endpoint prompt for the self-hosted API-key login", async () => {
		vi.mocked(promptLoginMethod).mockResolvedValue({ kind: "next", value: "api-key" })
		vi.mocked(promptLoginRegion).mockResolvedValue({ kind: "next", value: "self-hosted" })
		vi.mocked(promptSelfHostedConsoleEndpoints).mockResolvedValue({ kind: "next", value: DISCOVERED_ENDPOINTS })
		vi.mocked(promptKimchiApiKey).mockResolvedValue({ kind: "next", value: "castai_v1_key" })

		expect(await runLogin([], INTERACTIVE)).toBe(0)

		expect(promptKimchiEndpoint).not.toHaveBeenCalled()
		expect(performKimchiApiKeyLogin).toHaveBeenCalledWith(expect.anything(), {
			apiKey: "castai_v1_key",
			endpoint: "",
			region: "self-hosted",
			selfHostedEndpoints: DISCOVERED_ENDPOINTS,
		})
	})

	it("backs out to the method selector when Esc is pressed at the API-key prompt", async () => {
		vi.mocked(promptLoginMethod)
			.mockResolvedValueOnce({ kind: "next", value: "api-key" })
			.mockResolvedValueOnce({ kind: "back" })
		vi.mocked(promptLoginRegion).mockResolvedValue({ kind: "next", value: "us" })
		vi.mocked(promptKimchiApiKey).mockResolvedValue({ kind: "back" })

		expect(await runLogin([], INTERACTIVE)).toBe(0)

		expect(promptLoginMethod).toHaveBeenCalledTimes(2)
		expect(performKimchiApiKeyLogin).not.toHaveBeenCalled()
	})

	it("runs the SSO login and completes it", async () => {
		vi.mocked(promptLoginMethod).mockResolvedValue({ kind: "next", value: "sso" })
		vi.mocked(promptLoginRegion).mockResolvedValue({ kind: "next", value: "eu" })
		vi.mocked(loginWithCastAiOauth).mockResolvedValue({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 3_600_000,
			region: "eu",
			tokenUrl: "https://login.eu.kimchi.dev/oauth/token",
			clientId: "client-id",
			useIdToken: true,
			orgId: "org-1",
			orgName: "Acme",
		})

		expect(await runLogin([], INTERACTIVE)).toBe(0)

		expect(loginWithCastAiOauth).toHaveBeenCalled()
		expect(completeKimchiSsoLogin).toHaveBeenCalled()
	})

	it("maps an SSO callback-port conflict to a clear error", async () => {
		vi.mocked(promptLoginMethod).mockResolvedValue({ kind: "next", value: "sso" })
		vi.mocked(promptLoginRegion).mockResolvedValue({ kind: "next", value: "us" })
		vi.mocked(loginWithCastAiOauth).mockRejectedValue(
			Object.assign(new Error("listen EADDRINUSE: address in use :::8765"), { code: "EADDRINUSE" }),
		)

		expect(await runLogin([], INTERACTIVE)).toBe(1)

		expect(console.error).toHaveBeenCalledWith(
			"CAST AI SSO login appears to be in progress elsewhere — finish it, then retry.",
		)
	})

	it("treats an aborted SSO wait as a cancellation (exit 0)", async () => {
		vi.mocked(promptLoginMethod).mockResolvedValue({ kind: "next", value: "sso" })
		vi.mocked(promptLoginRegion).mockResolvedValue({ kind: "next", value: "us" })
		vi.mocked(loginWithCastAiOauth).mockRejectedValue(new Error("Login cancelled"))

		expect(await runLogin([], INTERACTIVE)).toBe(0)
		expect(console.log).toHaveBeenCalledWith("Login cancelled.")
	})
})
