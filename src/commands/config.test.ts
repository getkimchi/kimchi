import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — declared before imports that consume them
// ---------------------------------------------------------------------------

// Mock config.js so readTelemetryConfig/writeTelemetryEnabled are no-ops.
vi.mock("../config.js", () => ({
	readTelemetryConfig: vi.fn(),
	writeTelemetryEnabled: vi.fn(),
	writeTuiWheelScrollLines: vi.fn(),
	loadConfig: vi.fn(),
}))

// Mock sendPreSessionEvent — we assert the config command invokes it with the
// correct event name + key/value. The real no-op-when-disabled behaviour of
// sendPreSessionEvent is covered in pre-session.test.ts; this test isolates
// the config command's contract (it decides WHAT to emit).
vi.mock("../extensions/telemetry/pre-session.js", () => ({
	sendPreSessionEvent: vi.fn(),
}))

// Passthrough default (no org enforcement); policy tests steer with
// enforceTelemetryPolicyForTests. clearAllMocks does not reset
// implementations, so defaults are restored per test via resetTelemetryPolicyMock.
vi.mock("../telemetry-policy.js", () => telemetryPolicyMock)

import { loadConfig, readTelemetryConfig, writeTelemetryEnabled, writeTuiWheelScrollLines } from "../config.js"
import {
	enforceTelemetryPolicyForTests,
	resetTelemetryPolicyMock,
	telemetryPolicyMock,
} from "../extensions/__mocks__/telemetry-policy.js"
import { withExperimentalFeatures } from "../extensions/experimental.js"
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

describe("kimchi config telemetry — org policy enforcement", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "log").mockImplementation(() => {})
		// Reset to passthrough defaults; per-test overrides follow.
		resetTelemetryPolicyMock()
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it("status shows the effective state and the policy source under FORCE_OFF", async () => {
		enforceTelemetryPolicyForTests("FORCE_OFF")
		vi.mocked(readTelemetryConfig).mockReturnValue(makeTelemetryConfig({ enabled: true }))

		const exit = await runConfig(["telemetry"])

		expect(exit).toBe(0)
		expect(console.log).toHaveBeenCalledWith("Telemetry: disabled (enforced off by your organization's policy)")
	})

	it("status shows the effective state and the policy source under FORCE_ON", async () => {
		enforceTelemetryPolicyForTests("FORCE_ON")
		vi.mocked(readTelemetryConfig).mockReturnValue(makeTelemetryConfig({ enabled: false }))

		const exit = await runConfig(["telemetry"])

		expect(exit).toBe(0)
		expect(console.log).toHaveBeenCalledWith("Telemetry: enabled (enforced on by your organization's policy)")
	})

	it("status under FORCE_ON composes the policy and env-var notes", async () => {
		enforceTelemetryPolicyForTests("FORCE_ON")
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "0")
		vi.mocked(readTelemetryConfig).mockReturnValue(makeTelemetryConfig({ enabled: true }))

		const exit = await runConfig(["telemetry"])

		expect(exit).toBe(0)
		expect(console.log).toHaveBeenCalledWith(
			"Telemetry: enabled (enforced on by your organization's policy; from KIMCHI_TELEMETRY_ENABLED=0, overrides config)",
		)
	})

	it("FORCE_OFF: writes persist but emit no config_changed, and an opted-in write warns", async () => {
		enforceTelemetryPolicyForTests("FORCE_OFF")

		const exit = await runConfig(["telemetry", "on"])

		expect(exit).toBe(0)
		expect(writeTelemetryEnabled).toHaveBeenCalledWith(true)
		expect(sendPreSessionEvent).not.toHaveBeenCalled()
		expect(console.log).toHaveBeenCalledWith("Telemetry enabled")
		expect(console.log).toHaveBeenCalledWith(
			"Note: your organization's policy enforces telemetry off; effective state unchanged.",
		)
	})

	it("FORCE_OFF: an opted-out write is aligned and stays silent", async () => {
		enforceTelemetryPolicyForTests("FORCE_OFF")

		const exit = await runConfig(["telemetry", "off"])

		expect(exit).toBe(0)
		expect(writeTelemetryEnabled).toHaveBeenCalledWith(false)
		expect(sendPreSessionEvent).not.toHaveBeenCalled()
		expect(console.log).toHaveBeenCalledTimes(1)
		expect(console.log).toHaveBeenCalledWith("Telemetry disabled")
	})

	it("FORCE_ON: an opted-out write still emits config_changed and warns about enforcement", async () => {
		enforceTelemetryPolicyForTests("FORCE_ON")
		vi.mocked(readTelemetryConfig).mockReturnValue(makeTelemetryConfig({ enabled: false }))

		const exit = await runConfig(["telemetry", "off"])

		expect(exit).toBe(0)
		expect(writeTelemetryEnabled).toHaveBeenCalledWith(false)
		expect(sendPreSessionEvent).toHaveBeenCalledTimes(1)
		expect(lastCall().properties).toEqual({ key: "telemetry.enabled", value: false })
		// The force-enable hack still applies: reporting is permitted under FORCE_ON.
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		expect(vi.mocked(sendPreSessionEvent).mock.calls[0]![0].enabled).toBe(true)
		expect(console.log).toHaveBeenCalledWith(
			"Note: your organization's policy enforces telemetry on; effective state unchanged.",
		)
	})

	it("FORCE_ON: an opted-in write is aligned and stays silent", async () => {
		enforceTelemetryPolicyForTests("FORCE_ON")
		vi.mocked(readTelemetryConfig).mockReturnValue(makeTelemetryConfig({ enabled: true }))

		const exit = await runConfig(["telemetry", "on"])

		expect(exit).toBe(0)
		expect(sendPreSessionEvent).toHaveBeenCalledTimes(1)
		expect(console.log).toHaveBeenCalledTimes(1)
		expect(console.log).toHaveBeenCalledWith("Telemetry enabled")
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

	it("prints the current region and the available regions", async () => {
		await withExperimentalFeatures(true, async () => {
			vi.mocked(loadConfig).mockReturnValue({ apiKey: "", region: "us" } as ReturnType<typeof loadConfig>)

			const exit = await runConfig(["region"])

			expect(exit).toBe(0)
			expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe("Region: us — United States")
			expect(vi.mocked(console.log).mock.calls[1]?.[0]).toBe(
				"Available regions: us (United States), eu (Europe), self-hosted (Self-hosted)",
			)
		})
	})

	it("lists only the default region when EU is experimental-gated", async () => {
		vi.mocked(loadConfig).mockReturnValue({ apiKey: "", region: "us" } as ReturnType<typeof loadConfig>)

		const exit = await runConfig(["region"])

		expect(exit).toBe(0)
		expect(vi.mocked(console.log).mock.calls[1]?.[0]).toBe("Available regions: us (United States)")
	})

	it("notes the KIMCHI_REGION env override when it is in effect", async () => {
		vi.stubEnv("KIMCHI_REGION", "eu")
		vi.mocked(loadConfig).mockReturnValue({
			apiKey: "",
			region: "eu",
		} as ReturnType<typeof loadConfig>)

		const exit = await runConfig(["region"])

		expect(exit).toBe(0)
		expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe(
			"Region: eu — Europe (from KIMCHI_REGION=eu, overrides config)",
		)
	})

	it("prints the configured region", async () => {
		vi.mocked(loadConfig).mockReturnValue({
			apiKey: "",
			region: "eu",
		} as ReturnType<typeof loadConfig>)

		const exit = await runConfig(["region"])

		expect(exit).toBe(0)
		expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe("Region: eu — Europe")
	})

	it("does not claim an invalid KIMCHI_REGION as an override", async () => {
		vi.stubEnv("KIMCHI_REGION", "moon")
		vi.mocked(loadConfig).mockReturnValue({
			apiKey: "",
			region: "eu",
		} as ReturnType<typeof loadConfig>)

		const exit = await runConfig(["region"])

		expect(exit).toBe(0)
		expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toBe(
			"Ignoring invalid KIMCHI_REGION=moon (expected us|eu|self-hosted)",
		)
		expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe("Region: eu — Europe")
	})

	it("prints the self-hosted region with its configured base URL", async () => {
		await withExperimentalFeatures(true, async () => {
			vi.mocked(loadConfig).mockReturnValue({
				apiKey: "",
				region: "self-hosted",
				selfHostedUrl: "https://kimchi.example.com",
			} as ReturnType<typeof loadConfig>)

			const exit = await runConfig(["region"])

			expect(exit).toBe(0)
			expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe("Region: self-hosted — Self-hosted")
			expect(vi.mocked(console.log).mock.calls[1]?.[0]).toBe("Self-hosted base URL: https://kimchi.example.com")
			expect(vi.mocked(console.log).mock.calls[2]?.[0]).toBe(
				"Available regions: us (United States), eu (Europe), self-hosted (Self-hosted)",
			)
		})
	})

	it("notes the KIMCHI_SELF_HOSTED_URL env override when it is in effect", async () => {
		vi.stubEnv("KIMCHI_SELF_HOSTED_URL", "https://env.example.com")
		vi.mocked(loadConfig).mockReturnValue({
			apiKey: "",
			region: "self-hosted",
			selfHostedUrl: "https://env.example.com",
		} as ReturnType<typeof loadConfig>)

		const exit = await runConfig(["region"])

		expect(exit).toBe(0)
		expect(vi.mocked(console.log).mock.calls[1]?.[0]).toBe(
			"Self-hosted base URL: https://env.example.com (from KIMCHI_SELF_HOSTED_URL, overrides config)",
		)
	})

	it("prints a self-hosted region without a base URL as not configured", async () => {
		vi.mocked(loadConfig).mockReturnValue({
			apiKey: "",
			region: "self-hosted",
			selfHostedUrl: undefined,
		} as ReturnType<typeof loadConfig>)

		const exit = await runConfig(["region"])

		expect(exit).toBe(0)
		expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe("Region: self-hosted — Self-hosted")
		expect(vi.mocked(console.log).mock.calls[1]?.[0]).toBe(
			'Self-hosted base URL: not configured — set KIMCHI_SELF_HOSTED_URL or run "kimchi login" and choose Self-hosted',
		)
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

describe("kimchi config set tui.wheelScrollLines", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it("writes the value to global config", async () => {
		const exit = await runConfig(["set", "tui.wheelScrollLines", "3"])

		expect(exit).toBe(0)
		expect(writeTuiWheelScrollLines).toHaveBeenCalledWith(3)
	})

	it.each(["0", "-2", "abc", "2.7", ""])("rejects invalid value %j (exit 2, no write)", async (raw) => {
		vi.spyOn(console, "error").mockImplementation(() => {})

		const exit = await runConfig(["set", "tui.wheelScrollLines", raw])

		expect(exit).toBe(2)
		expect(writeTuiWheelScrollLines).not.toHaveBeenCalled()
	})

	it("refuses unknown keys and lists the writable ones (exit 2)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {
			/* silence */
		})

		const exit = await runConfig(["set", "apiKey", "hunter2"])

		expect(exit).toBe(2)
		expect(writeTuiWheelScrollLines).not.toHaveBeenCalled()
		expect(vi.mocked(console.error)).toHaveBeenCalledWith(expect.stringContaining('unknown or read-only key "apiKey"'))
		expect(vi.mocked(console.error)).toHaveBeenCalledWith(expect.stringContaining("tui.wheelScrollLines"))
	})

	it("requires both key and value (exit 2)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {
			/* silence */
		})

		expect(await runConfig(["set", "tui.wheelScrollLines"])).toBe(2)
		expect(await runConfig(["set"])).toBe(2)
		expect(writeTuiWheelScrollLines).not.toHaveBeenCalled()
	})

	it("warns when the env override shadows the written value", async () => {
		vi.stubEnv("KIMCHI_WHEEL_SCROLL_LINES", "5")

		const exit = await runConfig(["set", "tui.wheelScrollLines", "3"])

		expect(exit).toBe(0)
		expect(writeTuiWheelScrollLines).toHaveBeenCalledWith(3)
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("KIMCHI_WHEEL_SCROLL_LINES=5 is set and overrides this value"),
		)
	})
})

describe("kimchi config get tui.wheelScrollLines", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it("shows the configured value from the merged config", async () => {
		vi.mocked(loadConfig).mockReturnValue({ tui: { wheelScrollLines: 4 } } as ReturnType<typeof loadConfig>)

		const exit = await runConfig(["get", "tui.wheelScrollLines"])

		expect(exit).toBe(0)
		expect(console.log).toHaveBeenCalledWith("tui.wheelScrollLines: 4 (from config)")
	})

	it("shows the default note when unset", async () => {
		vi.mocked(loadConfig).mockReturnValue({} as ReturnType<typeof loadConfig>)

		const exit = await runConfig(["get", "tui.wheelScrollLines"])

		expect(exit).toBe(0)
		expect(console.log).toHaveBeenCalledWith("tui.wheelScrollLines: unset (default 1) (from config)")
	})

	it("notes the env override when it is in effect", async () => {
		vi.stubEnv("KIMCHI_WHEEL_SCROLL_LINES", "7")

		const exit = await runConfig(["get", "tui.wheelScrollLines"])

		expect(exit).toBe(0)
		expect(console.log).toHaveBeenCalledWith(
			"tui.wheelScrollLines: 7 (from KIMCHI_WHEEL_SCROLL_LINES, overrides config)",
		)
		expect(loadConfig).not.toHaveBeenCalled()
	})

	it("refuses unknown keys (exit 2)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {
			/* silence */
		})

		const exit = await runConfig(["get", "nope.nope"])

		expect(exit).toBe(2)
	})
})
