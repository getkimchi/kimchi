import { afterEach, describe, expect, it, vi } from "vitest"

import type { TelemetryConfig } from "./config.js"
import { resetOrgPolicyForTests } from "./org-policy.js"
import { setOrgPolicyForTests } from "./org-policy.test-utils.js"
import {
	applyTelemetryPolicy,
	enforceTelemetryEnabled,
	isTelemetryEnabled,
	isTelemetryPolicyEnforced,
	readEffectiveTelemetryConfig,
	usageReportingPolicy,
} from "./telemetry-policy.js"

/** Seed the policy holder with a usage-reporting-only directive via the shared test helper. */
const setUsageReporting = (policy: "USER_CHOICE" | "FORCE_ON" | "FORCE_OFF" | undefined) =>
	setOrgPolicyForTests(policy === undefined ? undefined : { usageReporting: policy })

afterEach(() => {
	resetOrgPolicyForTests()
	vi.unstubAllEnvs()
})

function configWith(enabled: boolean): TelemetryConfig {
	return {
		enabled,
		endpoint: "https://telemetry.test/logs:ingest",
		metricsEndpoint: "https://telemetry.test/metrics:ingest",
		headers: { Authorization: "Bearer key" },
		apiKey: "key",
	}
}

describe("usageReportingPolicy / isTelemetryPolicyEnforced", () => {
	it("reports no policy when the holder is empty (fail open)", async () => {
		await setUsageReporting(undefined)
		expect(usageReportingPolicy()).toBeUndefined()
		expect(isTelemetryPolicyEnforced()).toBe(false)
	})

	it("USER_CHOICE is surfaced but is not enforcement", async () => {
		await setUsageReporting("USER_CHOICE")
		expect(usageReportingPolicy()).toBe("USER_CHOICE")
		expect(isTelemetryPolicyEnforced()).toBe(false)
	})

	it.each(["FORCE_ON", "FORCE_OFF"] as const)("%s is enforcement", async (policy) => {
		await setUsageReporting(policy)
		expect(usageReportingPolicy()).toBe(policy)
		expect(isTelemetryPolicyEnforced()).toBe(true)
	})
})

describe("enforceTelemetryEnabled", () => {
	it.each([
		[undefined, true, true],
		[undefined, false, false],
		["USER_CHOICE", true, true],
		["USER_CHOICE", false, false],
		["FORCE_ON", true, true],
		["FORCE_ON", false, true],
		["FORCE_OFF", true, false],
		["FORCE_OFF", false, false],
	] as const)("policy %s × user enabled %s → %s", async (policy, userEnabled, expected) => {
		await setUsageReporting(policy)
		expect(enforceTelemetryEnabled(userEnabled)).toBe(expected)
	})
})

describe("applyTelemetryPolicy", () => {
	it("returns the same object when no policy applies", async () => {
		await setUsageReporting(undefined)
		const config = configWith(false)
		expect(applyTelemetryPolicy(config)).toBe(config)
	})

	it("returns the same object when USER_CHOICE leaves the flag alone", async () => {
		await setUsageReporting("USER_CHOICE")
		const config = configWith(false)
		expect(applyTelemetryPolicy(config)).toBe(config)
	})

	it("FORCE_ON flips an opted-out config to enabled and keeps endpoints/headers", async () => {
		await setUsageReporting("FORCE_ON")
		const config = configWith(false)
		const enforced = applyTelemetryPolicy(config)
		expect(enforced).not.toBe(config)
		expect(enforced.enabled).toBe(true)
		expect(enforced.endpoint).toBe(config.endpoint)
		expect(enforced.metricsEndpoint).toBe(config.metricsEndpoint)
		expect(enforced.headers).toEqual(config.headers)
		expect(enforced.apiKey).toBe(config.apiKey)
		// The input is not mutated.
		expect(config.enabled).toBe(false)
	})

	it("FORCE_OFF flips an opted-in config to disabled and keeps endpoints/headers", async () => {
		await setUsageReporting("FORCE_OFF")
		const config = configWith(true)
		const enforced = applyTelemetryPolicy(config)
		expect(enforced.enabled).toBe(false)
		expect(enforced.endpoint).toBe(config.endpoint)
		expect(enforced.headers).toEqual(config.headers)
		expect(config.enabled).toBe(true)
	})
})

describe("isTelemetryEnabled", () => {
	it.each([
		[undefined, "false", false],
		[undefined, "true", true],
		["USER_CHOICE", "false", false],
		["USER_CHOICE", "true", true],
		["FORCE_ON", "false", true],
		["FORCE_OFF", "true", false],
	] as const)("policy %s with env %s → %s", async (policy, env, expected) => {
		await setUsageReporting(policy)
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", env)
		expect(isTelemetryEnabled()).toBe(expected)
	})
})

describe("readEffectiveTelemetryConfig", () => {
	it("clamps enabled under FORCE_ON and preserves the rest of the config", async () => {
		await setUsageReporting("FORCE_ON")
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		const cfg = readEffectiveTelemetryConfig()
		expect(cfg.enabled).toBe(true)
		expect(cfg.endpoint).toBeTruthy()
		expect(cfg.metricsEndpoint).toBeTruthy()
	})

	it("passes the user setting through when no policy applies", async () => {
		await setUsageReporting(undefined)
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		expect(readEffectiveTelemetryConfig().enabled).toBe(false)
	})

	it("forces enabled under FORCE_OFF even when the user opted in", async () => {
		await setUsageReporting("FORCE_OFF")
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		expect(readEffectiveTelemetryConfig().enabled).toBe(false)
	})
})
