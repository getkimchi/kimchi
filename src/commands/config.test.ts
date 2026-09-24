import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — declared before imports that consume them
// ---------------------------------------------------------------------------

// Mock config.js so readTelemetryConfig/writeTelemetryEnabled are no-ops.
vi.mock("../config.js", () => ({
	readTelemetryConfig: vi.fn(),
	writeTelemetryEnabled: vi.fn(),
	loadConfig: vi.fn(),
}))

// Mock sendPreSessionEvent — we assert the config command invokes it with the
// correct event name + key/value. The real no-op-when-disabled behaviour of
// sendPreSessionEvent is covered in pre-session.test.ts; this test isolates
// the config command's contract (it decides WHAT to emit).
vi.mock("../extensions/telemetry/pre-session.js", () => ({
	sendPreSessionEvent: vi.fn(),
}))

import { loadConfig, readTelemetryConfig, writeTelemetryEnabled } from "../config.js"
import { sendPreSessionEvent } from "../extensions/telemetry/pre-session.js"
import { runConfig } from "./config.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTelemetryConfig(overrides?: Record<string, unknown>) {
	return {
		enabled: true,
		endpoint: "https://api.cast.ai/logs",
		metricsEndpoint: "https://api.cast.ai/metrics",
		headers: { Authorization: "Bearer test-key" },
		apiKey: "test-key",
		...overrides,
	}
}

/** Extract the (event, properties) args from the last sendPreSessionEvent call. */
function lastCall() {
	const calls = vi.mocked(sendPreSessionEvent).mock.calls
	expect(calls.length).toBeGreaterThan(0)
	// biome-ignore lint/style/noNonNullAssertion: test helper — length checked above
	const last = calls[calls.length - 1]!
	return { event: last[1], properties: last[2] }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kimchi config telemetry — config_changed event", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("emits config_changed with telemetry.enabled=true when turning on", async () => {
		vi.mocked(readTelemetryConfig).mockReturnValue(makeTelemetryConfig({ enabled: true }))

		const exit = await runConfig(["telemetry", "on"])

		expect(exit).toBe(0)
		expect(writeTelemetryEnabled).toHaveBeenCalledWith(true)
		// Re-reads config AFTER writing so the emitted config reflects new state.
		expect(readTelemetryConfig).toHaveBeenCalled()
		expect(sendPreSessionEvent).toHaveBeenCalledTimes(1)
		expect(lastCall()).toEqual({
			event: "config_changed",
			properties: { key: "telemetry.enabled", value: true },
		})
	})

	it("emits config_changed with telemetry.enabled=false when turning off", async () => {
		vi.mocked(readTelemetryConfig).mockReturnValue(makeTelemetryConfig({ enabled: false }))

		const exit = await runConfig(["telemetry", "off"])

		expect(exit).toBe(0)
		expect(writeTelemetryEnabled).toHaveBeenCalledWith(false)
		expect(sendPreSessionEvent).toHaveBeenCalledTimes(1)
		expect(lastCall()).toEqual({
			event: "config_changed",
			properties: { key: "telemetry.enabled", value: false },
		})
		// When turning telemetry OFF, the re-read config has enabled=false, which
		// would cause sendPreSessionEvent to no-op and drop the opt-out signal.
		// The config command forces enabled=true on the passed config so the
		// event reaches the backend, while `value` carries the actual new state.
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		const configArg = vi.mocked(sendPreSessionEvent).mock.calls[0]![0]
		expect(configArg.enabled).toBe(true)
	})

	it("accepts the common on/true/yes/1/enable spellings", async () => {
		for (const s of ["on", "true", "yes", "1", "enable", "enabled"]) {
			vi.clearAllMocks()
			vi.mocked(readTelemetryConfig).mockReturnValue(makeTelemetryConfig({ enabled: true }))
			await runConfig(["telemetry", s])
			expect(sendPreSessionEvent).toHaveBeenCalledTimes(1)
			expect(lastCall().properties).toEqual({ key: "telemetry.enabled", value: true })
		}
	})

	it("accepts the common off/false/no/0/disable spellings", async () => {
		for (const s of ["off", "false", "no", "0", "disable", "disabled"]) {
			vi.clearAllMocks()
			vi.mocked(readTelemetryConfig).mockReturnValue(makeTelemetryConfig({ enabled: false }))
			await runConfig(["telemetry", s])
			expect(sendPreSessionEvent).toHaveBeenCalledTimes(1)
			expect(lastCall().properties).toEqual({ key: "telemetry.enabled", value: false })
		}
	})

	it("does not emit config_changed for an invalid switch value (exit 2)", async () => {
		const exit = await runConfig(["telemetry", "maybe"])
		expect(exit).toBe(2)
		expect(writeTelemetryEnabled).not.toHaveBeenCalled()
		expect(sendPreSessionEvent).not.toHaveBeenCalled()
	})

	it("prints status and does not emit when no value is given", async () => {
		vi.mocked(readTelemetryConfig).mockReturnValue(makeTelemetryConfig({ enabled: true }))
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		const exit = await runConfig(["telemetry"])

		expect(exit).toBe(0)
		expect(writeTelemetryEnabled).not.toHaveBeenCalled()
		expect(sendPreSessionEvent).not.toHaveBeenCalled()
		logSpy.mockRestore()
	})

	it("always passes the re-read config as the first sendPreSessionEvent arg", async () => {
		const cfg = makeTelemetryConfig({ enabled: true })
		vi.mocked(readTelemetryConfig).mockReturnValue(cfg)

		await runConfig(["telemetry", "on"])

		expect(sendPreSessionEvent).toHaveBeenCalledTimes(1)
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		const configArg = vi.mocked(sendPreSessionEvent).mock.calls[0]![0]
		expect(configArg).toBe(cfg)
	})
})

describe("kimchi config region", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it("prints the default region when none is configured", async () => {
		vi.mocked(loadConfig).mockReturnValue({ apiKey: "" } as ReturnType<typeof loadConfig>)

		const exit = await runConfig(["region"])

		expect(exit).toBe(0)
		expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe("Region: us — United States (default)")
		expect(vi.mocked(console.log).mock.calls[1]?.[0]).toContain("Available regions:")
		expect(vi.mocked(console.log).mock.calls[1]?.[0]).toContain("eu")
	})

	it("notes the KIMCHI_REGION env override when it is in effect", async () => {
		vi.stubEnv("KIMCHI_REGION", "eu")
		vi.mocked(loadConfig).mockReturnValue({ apiKey: "", region: "eu" } as ReturnType<typeof loadConfig>)

		const exit = await runConfig(["region"])

		expect(exit).toBe(0)
		expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe(
			"Region: eu — Europe (from KIMCHI_REGION=eu, overrides config)",
		)
	})

	it("prints the configured region", async () => {
		vi.mocked(loadConfig).mockReturnValue({ apiKey: "", region: "eu" } as ReturnType<typeof loadConfig>)

		const exit = await runConfig(["region"])

		expect(exit).toBe(0)
		expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe("Region: eu — Europe")
	})

	it("refuses to set a region and directs the user to re-login (exit 2)", async () => {
		vi.mocked(loadConfig).mockReturnValue({ apiKey: "" } as ReturnType<typeof loadConfig>)
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const exit = await runConfig(["region", "eu"])

		expect(exit).toBe(2)
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Run "kimchi login" again to switch regions'))
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("KIMCHI_REGION=us|eu"))
		// Nothing was printed except via console.error.
		expect(console.log).not.toHaveBeenCalled()
	})

	it("rejects an unknown region id the same way (exit 2, same guidance)", async () => {
		vi.mocked(loadConfig).mockReturnValue({ apiKey: "" } as ReturnType<typeof loadConfig>)
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const exit = await runConfig(["region", "moon"])

		expect(exit).toBe(2)
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Run "kimchi login" again to switch regions'))
	})
})
