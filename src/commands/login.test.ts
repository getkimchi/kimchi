import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@clack/prompts", () => ({ spinner: () => ({ start: vi.fn(), stop: vi.fn() }) }))
vi.mock("../cli-auth/index.js", () => ({ authenticateViaBrowser: vi.fn() }))
vi.mock("../self-hosted-discovery.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../self-hosted-discovery.js")>()
	return { ...actual, fetchSelfHostedEndpoints: vi.fn() }
})

import { authenticateViaBrowser } from "../cli-auth/index.js"
import * as config from "../config.js"
import { fetchSelfHostedEndpoints } from "../self-hosted-discovery.js"
import { runLogin } from "./login.js"

const DISCOVERED_ENDPOINTS = {
	api: "https://kimchi.example.com",
	console: "https://kimchi.example.com",
	llm: "https://llm.example.com",
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.spyOn(config, "writeApiKey").mockImplementation(() => {})
	vi.mocked(authenticateViaBrowser).mockResolvedValue({ token: "new-key" })
	vi.mocked(fetchSelfHostedEndpoints).mockResolvedValue({ status: "discovered", endpoints: DISCOVERED_ENDPOINTS })
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

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

describe("kimchi login <console-url> (self-hosted flow)", () => {
	it("discovers endpoints, runs the browser login against the console, and persists them", async () => {
		expect(await runLogin([" https://kimchi.example.com/ "])).toBe(0)

		// Discovery runs against the normalized console URL.
		expect(fetchSelfHostedEndpoints).toHaveBeenCalledWith("https://kimchi.example.com")
		// The browser flow targets the console (the SPA serving /cli-auth).
		expect(authenticateViaBrowser).toHaveBeenCalledWith(
			expect.objectContaining({ webAppUrl: "https://kimchi.example.com" }),
		)
		// The key is stored with the region and the endpoints.
		expect(config.writeApiKey).toHaveBeenCalledWith("new-key", undefined, {
			region: "self-hosted",
			selfHostedEndpoints: DISCOVERED_ENDPOINTS,
		})
	})

	it("falls back to the manual single-base flow when the install predates discovery", async () => {
		vi.mocked(fetchSelfHostedEndpoints).mockResolvedValue({
			status: "unavailable",
			cause: "not-found",
			reason: "no discovery document at /env/endpoints.json (HTTP 404)",
		})

		expect(await runLogin(["https://kimchi.example.com"])).toBe(0)

		expect(authenticateViaBrowser).toHaveBeenCalledWith(
			expect.objectContaining({ webAppUrl: "https://kimchi.example.com" }),
		)
		// The manual fallback persists the endpoints derived from the URL.
		const derived = {
			api: "https://kimchi.example.com/api",
			console: "https://kimchi.example.com",
			llm: "https://kimchi.example.com/llm",
		}
		expect(config.writeApiKey).toHaveBeenCalledWith("new-key", undefined, {
			region: "self-hosted",
			selfHostedEndpoints: derived,
		})
	})

	it("rejects an invalid console URL without touching auth", async () => {
		expect(await runLogin(["not a url"])).toBe(1)

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Invalid console URL"))
		expect(fetchSelfHostedEndpoints).not.toHaveBeenCalled()
		expect(authenticateViaBrowser).not.toHaveBeenCalled()
		expect(config.writeApiKey).not.toHaveBeenCalled()
	})

	it("rejects more than one URL argument", async () => {
		expect(await runLogin(["https://kimchi.example.com", "https://other.example.com"])).toBe(1)

		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("at most one URL"))
		expect(authenticateViaBrowser).not.toHaveBeenCalled()
	})

	it("propagates browser-login failure as exit code 1 without persisting", async () => {
		vi.mocked(authenticateViaBrowser).mockRejectedValue(new Error("Login cancelled"))

		expect(await runLogin(["https://kimchi.example.com"])).toBe(1)

		expect(config.writeApiKey).not.toHaveBeenCalled()
	})
})
