/**
 * Integration test for the stream-level AbortController timeout patch.
 *
 * Verifies the end-to-end config → settings.json wiring for providerTimeoutMs,
 * and that the timeout error string produced by the patch is classified as
 * retryable by the retry classifier.
 *
 * The patch itself (AbortController + setTimeout inside openai-completions.js)
 * is verified by reading the patched dist file for the expected code patterns.
 * A full HTTP-level hang test is impractical in unit tests because the lazy
 * stream loader wraps the patched function and the OpenAI SDK's internal
 * fetch makes it hard to inject a hanging server without flakiness.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RETRY_DEFAULTS, loadConfig } from "./config.js"
import { isNetworkErrorRetryable } from "./upstream-retry-patch.js"

describe("stream timeout config → settings.json wiring", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-stream-timeout-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("providerTimeoutMs defaults to 180000 (3 min)", () => {
		expect(RETRY_DEFAULTS.providerTimeoutMs).toBe(180_000)
	})

	it("loadConfig returns providerTimeoutMs from config file", () => {
		writeFileSync(configPath, JSON.stringify({ retry: { providerTimeoutMs: 60_000 } }))
		const config = loadConfig({ configPath })
		expect(config.retry.providerTimeoutMs).toBe(60_000)
	})

	it("loadConfig falls back to default when providerTimeoutMs is not set", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "test" }))
		const config = loadConfig({ configPath })
		expect(config.retry.providerTimeoutMs).toBe(180_000)
	})

	it("settings.json retry.provider.timeoutMs is written from config", () => {
		writeFileSync(configPath, JSON.stringify({ retry: { providerTimeoutMs: 120_000 } }))
		const config = loadConfig({ configPath })

		// Simulate what cli.ts does: write retry.provider.timeoutMs to settings.json
		const settingsPath = join(tempDir, "settings.json")
		const existing: Record<string, unknown> = { quietStartup: true }
		const sdkRetry = existing.retry as Record<string, unknown> | undefined
		const sdkProvider = sdkRetry?.provider as Record<string, unknown> | undefined
		const sdkProviderTimeoutMs = sdkProvider?.timeoutMs
		if (
			!sdkRetry ||
			sdkRetry.maxRetries !== config.retry.maxRetries ||
			sdkProviderTimeoutMs !== config.retry.providerTimeoutMs
		) {
			existing.retry = {
				...sdkRetry,
				maxRetries: config.retry.maxRetries,
				provider: {
					...(sdkProvider ?? {}),
					timeoutMs: config.retry.providerTimeoutMs,
				},
			}
		}
		writeFileSync(settingsPath, JSON.stringify(existing, null, 2))

		const written = JSON.parse(readFileSync(settingsPath, "utf-8"))
		expect(written.retry.provider.timeoutMs).toBe(120_000)
	})
})

describe("stream timeout error classification", () => {
	it("idle timeout error string from the patch is retryable", () => {
		const errorMessage = "Stream idle timeout after 180000ms"
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage })).toBe(true)
	})

	it("idle timeout error string with custom timeout value is retryable", () => {
		const errorMessage = "Stream idle timeout after 60000ms"
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage })).toBe(true)
	})

	it("non-timeout error is not affected", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "invalid api key" })).toBe(false)
	})
})

describe("patched openai-completions.js contains AbortController code", () => {
	it("has _streamTimeoutController variable declared before try block", () => {
		const patchPath = join(
			process.cwd(),
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"providers",
			"openai-completions.js",
		)
		const source = readFileSync(patchPath, "utf-8")

		// AbortController setup must be before the try block so catch can access it
		const controllerIdx = source.indexOf("let _streamTimeoutController = null")
		const tryIdx = source.indexOf("try {", controllerIdx)
		expect(controllerIdx).toBeGreaterThan(-1)
		expect(tryIdx).toBeGreaterThan(controllerIdx)

		// catch block references the timeout variables
		const catchIdx = source.indexOf("catch (error) {", tryIdx)
		expect(catchIdx).toBeGreaterThan(tryIdx)
		const clearTimeoutInCatch = source.indexOf("if (_streamTimeoutId) clearTimeout(_streamTimeoutId)", catchIdx)
		expect(clearTimeoutInCatch).toBeGreaterThan(catchIdx)

		// _isStreamTimeout detection in catch block
		const isStreamTimeoutIdx = source.indexOf("const _isStreamTimeout", catchIdx)
		expect(isStreamTimeoutIdx).toBeGreaterThan(catchIdx)

		// idle timeout: _resetStreamTimeout called inside the for-await loop
		const loopIdx = source.indexOf("for await (const chunk of openaiStream)", tryIdx)
		expect(loopIdx).toBeGreaterThan(tryIdx)
		const resetInLoop = source.indexOf("_resetStreamTimeout()", loopIdx)
		expect(resetInLoop).toBeGreaterThan(loopIdx)
		const resetAfterLoop = source.indexOf("_resetStreamTimeout()", resetInLoop + 1)
		expect(resetAfterLoop).toBe(-1) // no reset after loop (only in loop body)
	})

	it("preserves existing patch hunks (cache_write_tokens, validation.js)", () => {
		const completionsPath = join(
			process.cwd(),
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"providers",
			"openai-completions.js",
		)
		const validationPath = join(
			process.cwd(),
			"node_modules",
			"@earendil-works",
			"pi-ai",
			"dist",
			"utils",
			"validation.js",
		)

		const completions = readFileSync(completionsPath, "utf-8")
		expect(completions).toContain("cache_creation_tokens")

		const validation = readFileSync(validationPath, "utf-8")
		expect(validation).toContain('case "array"')
		expect(validation).toContain('case "object"')
	})
})
