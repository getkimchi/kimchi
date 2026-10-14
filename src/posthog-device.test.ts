import { afterEach, describe, expect, it, vi } from "vitest"

import { loadConfig, readTelemetryConfig, writeDeviceId } from "./config.js"
import { resetOrgPolicyForTests } from "./org-policy.js"
import { setOrgPolicyForTests } from "./org-policy.test-utils.js"
import { ensureDeviceId } from "./posthog-device.js"

vi.mock("./config.js", () => ({
	loadConfig: vi.fn(),
	readTelemetryConfig: vi.fn(),
	resolveEndpoints: vi.fn(() => ({ platformApiUrl: "https://policy.test" })),
	writeDeviceId: vi.fn(),
}))

const mockedLoadConfig = vi.mocked(loadConfig)
const mockedReadTelemetryConfig = vi.mocked(readTelemetryConfig)
const mockedWriteDeviceId = vi.mocked(writeDeviceId)

/** Seed the policy holder with a usage-reporting-only directive via the shared test helper. */
const setUsageReporting = (policy: "USER_CHOICE" | "FORCE_ON" | "FORCE_OFF" | undefined) =>
	setOrgPolicyForTests(policy === undefined ? undefined : { usageReporting: policy })

function stubConfig(deviceId: string | undefined, telemetryEnabled: boolean) {
	mockedLoadConfig.mockReturnValue({ deviceId } as ReturnType<typeof loadConfig>)
	mockedReadTelemetryConfig.mockReturnValue({
		enabled: telemetryEnabled,
		endpoint: "https://telemetry.test/logs:ingest",
		metricsEndpoint: "https://telemetry.test/metrics:ingest",
		headers: {},
		apiKey: "",
	})
}

afterEach(() => {
	resetOrgPolicyForTests()
	vi.clearAllMocks()
})

describe("ensureDeviceId", () => {
	it("returns the persisted ID without consulting telemetry state", async () => {
		await setUsageReporting(undefined)
		stubConfig("existing-id", false)
		expect(ensureDeviceId()).toBe("existing-id")
		expect(mockedWriteDeviceId).not.toHaveBeenCalled()
	})

	it("mints and persists a new ID when telemetry is enabled", async () => {
		await setUsageReporting(undefined)
		stubConfig(undefined, true)
		const id = ensureDeviceId()
		expect(id).toMatch(/^[0-9a-f-]{36}$/)
		expect(mockedWriteDeviceId).toHaveBeenCalledWith(id)
	})

	it("returns empty when telemetry is disabled", async () => {
		await setUsageReporting(undefined)
		stubConfig(undefined, false)
		expect(ensureDeviceId()).toBe("")
		expect(mockedWriteDeviceId).not.toHaveBeenCalled()
	})

	it("FORCE_OFF blocks minting even when the user config enables telemetry", async () => {
		await setUsageReporting("FORCE_OFF")
		stubConfig(undefined, true)
		expect(ensureDeviceId()).toBe("")
		expect(mockedWriteDeviceId).not.toHaveBeenCalled()
	})

	it("FORCE_ON mints even when the user config disables telemetry", async () => {
		await setUsageReporting("FORCE_ON")
		stubConfig(undefined, false)
		const id = ensureDeviceId()
		expect(id).toMatch(/^[0-9a-f-]{36}$/)
		expect(mockedWriteDeviceId).toHaveBeenCalledWith(id)
	})

	it("USER_CHOICE preserves the user's setting", async () => {
		await setUsageReporting("USER_CHOICE")
		stubConfig(undefined, false)
		expect(ensureDeviceId()).toBe("")
		expect(mockedWriteDeviceId).not.toHaveBeenCalled()
	})
})
