/**
 * Integration test for the stream-level AbortController timeout patch.
 *
 * Verifies the end-to-end config → settings.json wiring for providerTimeoutMs
 * and providerTotalTimeoutMs, and that the timeout error strings produced by
 * the patch are classified as retryable by the retry classifier.
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

	it("providerTimeoutMs defaults to 60000 (1 min)", () => {
		expect(RETRY_DEFAULTS.providerTimeoutMs).toBe(60_000)
	})

	it("providerTotalTimeoutMs defaults to 660000 (11 min)", () => {
		expect(RETRY_DEFAULTS.providerTotalTimeoutMs).toBe(660_000)
	})

	it("loadConfig returns providerTimeoutMs from config file", () => {
		writeFileSync(configPath, JSON.stringify({ retry: { providerTimeoutMs: 60_000 } }))
		const config = loadConfig({ configPath })
		expect(config.retry.providerTimeoutMs).toBe(60_000)
	})

	it("loadConfig returns providerTotalTimeoutMs from config file", () => {
		writeFileSync(configPath, JSON.stringify({ retry: { providerTotalTimeoutMs: 300_000 } }))
		const config = loadConfig({ configPath })
		expect(config.retry.providerTotalTimeoutMs).toBe(300_000)
	})

	it("loadConfig falls back to defaults when not set", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "test" }))
		const config = loadConfig({ configPath })
		expect(config.retry.providerTimeoutMs).toBe(60_000)
		expect(config.retry.providerTotalTimeoutMs).toBe(660_000)
	})

	it("settings.json retry.provider.timeoutMs and totalTimeoutMs are written from config", () => {
		writeFileSync(
			configPath,
			JSON.stringify({ retry: { providerTimeoutMs: 120_000, providerTotalTimeoutMs: 600_000 } }),
		)
		const config = loadConfig({ configPath })

		// Simulate what cli.ts does: write retry.provider.timeoutMs to settings.json
		const settingsPath = join(tempDir, "settings.json")
		const existing: Record<string, unknown> = { quietStartup: true }
		const sdkRetry = existing.retry as Record<string, unknown> | undefined
		const sdkProvider = sdkRetry?.provider as Record<string, unknown> | undefined
		const sdkProviderTimeoutMs = sdkProvider?.timeoutMs
		const sdkProviderTotalTimeoutMs = sdkProvider?.totalTimeoutMs
		if (
			!sdkRetry ||
			sdkRetry.maxRetries !== config.retry.maxRetries ||
			sdkProviderTimeoutMs !== config.retry.providerTimeoutMs ||
			sdkProviderTotalTimeoutMs !== config.retry.providerTotalTimeoutMs
		) {
			existing.retry = {
				...sdkRetry,
				maxRetries: config.retry.maxRetries,
				provider: {
					...(sdkProvider ?? {}),
					timeoutMs: config.retry.providerTimeoutMs,
					totalTimeoutMs: config.retry.providerTotalTimeoutMs,
				},
			}
		}
		writeFileSync(settingsPath, JSON.stringify(existing, null, 2))

		const written = JSON.parse(readFileSync(settingsPath, "utf-8"))
		expect(written.retry.provider.timeoutMs).toBe(120_000)
		expect(written.retry.provider.totalTimeoutMs).toBe(600_000)
	})
})

describe("stream timeout error classification", () => {
	it("idle timeout error string from the patch is retryable", () => {
		const errorMessage = "Stream idle timeout after 60000ms"
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage })).toBe(true)
	})

	it("total timeout error string from the patch is retryable", () => {
		const errorMessage = "Request total timeout after 660000ms"
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage })).toBe(true)
	})

	it("idle timeout error string with custom timeout value is retryable", () => {
		const errorMessage = "Stream idle timeout after 120000ms"
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage })).toBe(true)
	})

	it("total timeout error string with custom timeout value is retryable", () => {
		const errorMessage = "Request total timeout after 300000ms"
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage })).toBe(true)
	})

	it("non-timeout error is not affected", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "invalid api key" })).toBe(false)
	})
})

describe("patched openai-completions.js contains AbortController code", () => {
	it("has _streamTimeoutController and _totalTimeoutController declared before try block", () => {
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

		// Both controllers must be before the try block so catch can access them
		const streamControllerIdx = source.indexOf("let _streamTimeoutController = null")
		const totalControllerIdx = source.indexOf("let _totalTimeoutController = null")
		const tryIdx = source.indexOf("try {", totalControllerIdx)
		expect(streamControllerIdx).toBeGreaterThan(-1)
		expect(totalControllerIdx).toBeGreaterThan(-1)
		expect(tryIdx).toBeGreaterThan(totalControllerIdx)

		// catch block references both timeout variables
		const catchIdx = source.indexOf("catch (error) {", tryIdx)
		expect(catchIdx).toBeGreaterThan(tryIdx)
		const clearTimeoutInCatch = source.indexOf("if (_streamTimeoutId) clearTimeout(_streamTimeoutId)", catchIdx)
		expect(clearTimeoutInCatch).toBeGreaterThan(catchIdx)
		const clearTotalTimeoutInCatch = source.indexOf("if (_totalTimeoutId) clearTimeout(_totalTimeoutId)", catchIdx)
		expect(clearTotalTimeoutInCatch).toBeGreaterThan(catchIdx)

		// Error classification for both timeout types
		const isTotalTimeoutIdx = source.indexOf("const _isTotalTimeout", catchIdx)
		expect(isTotalTimeoutIdx).toBeGreaterThan(catchIdx)
		const isStreamIdleTimeoutIdx = source.indexOf("const _isStreamIdleTimeout", catchIdx)
		expect(isStreamIdleTimeoutIdx).toBeGreaterThan(catchIdx)
	})

	it("idle timeout does NOT start before first byte (no _resetStreamTimeout before try block)", () => {
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

		// The idle timer should only start inside the for-await loop, not before the try block.
		const controllerSetupIdx = source.indexOf("if (options?.timeoutMs && options?.timeoutMs > 0) {")
		expect(controllerSetupIdx).toBeGreaterThan(-1)

		// Find the first occurrence of _resetStreamTimeout after the controller setup
		const firstResetAfterSetup = source.indexOf("_resetStreamTimeout()", controllerSetupIdx)

		// Find the try block
		const tryIdx = source.indexOf("try {", controllerSetupIdx)
		expect(tryIdx).toBeGreaterThan(controllerSetupIdx)

		// The first _resetStreamTimeout call should be inside the try block (in the for-await loop),
		// NOT before it. If it's before try, the idle timer starts during pre-stream.
		expect(firstResetAfterSetup).toBeGreaterThan(tryIdx)

		// Verify it's in the for-await loop
		const loopIdx = source.indexOf("for await (const chunk of openaiStream)", tryIdx)
		expect(loopIdx).toBeGreaterThan(tryIdx)
		expect(firstResetAfterSetup).toBeGreaterThan(loopIdx)

		// Ensure no _resetStreamTimeout call between controller setup and try block
		const preTrySection = source.substring(controllerSetupIdx, tryIdx)
		expect(preTrySection).not.toContain("_resetStreamTimeout()")
	})

	it("uses AbortSignal.any for combined signal", () => {
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
		expect(source).toContain("AbortSignal.any(_signals)")
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
