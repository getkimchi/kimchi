import { vi } from "vitest"

import { readTelemetryConfig, type TelemetryConfig } from "../../config.js"
import type { UsageReportingPolicy } from "../../telemetry-policy.js"

/**
 * Shared passthrough mock for the telemetry-policy module (no org
 * enforcement). Install per test file with:
 *
 *   vi.mock("<relative-path>/telemetry-policy.js", () => telemetryPolicyMock)
 *
 * Restore passthrough defaults with resetTelemetryPolicyMock() in beforeEach
 * (vi.clearAllMocks keeps factory implementations but drops per-test
 * overrides, so defaults must be re-applied), and steer enforcement with
 * enforceTelemetryPolicyForTests() where a test needs it.
 */
export const telemetryPolicyMock = {
	applyTelemetryPolicy: vi.fn((c: TelemetryConfig) => c),
	enforceTelemetryEnabled: vi.fn((userEnabled: boolean) => userEnabled),
	isTelemetryEnabled: vi.fn(() => telemetryPolicyMock.enforceTelemetryEnabled(readTelemetryConfig().enabled)),
	isTelemetryPolicyEnforced: vi.fn(() => false),
	readEffectiveTelemetryConfig: vi.fn(() => telemetryPolicyMock.applyTelemetryPolicy(readTelemetryConfig())),
	usageReportingPolicy: vi.fn((): UsageReportingPolicy | undefined => undefined),
}

/** Force the passthrough defaults back after per-test enforcement overrides. */
export function resetTelemetryPolicyMock(): void {
	telemetryPolicyMock.applyTelemetryPolicy.mockImplementation((c: TelemetryConfig) => c)
	telemetryPolicyMock.enforceTelemetryEnabled.mockImplementation((userEnabled: boolean) => userEnabled)
	telemetryPolicyMock.isTelemetryPolicyEnforced.mockReturnValue(false)
	telemetryPolicyMock.usageReportingPolicy.mockReturnValue(undefined)
}

/** Steer the mock into an enforced org directive: FORCE_ON forces on, FORCE_OFF forces off. */
export function enforceTelemetryPolicyForTests(policy: "FORCE_ON" | "FORCE_OFF"): void {
	const enabled = policy === "FORCE_ON"
	telemetryPolicyMock.isTelemetryPolicyEnforced.mockReturnValue(true)
	telemetryPolicyMock.usageReportingPolicy.mockReturnValue(policy)
	telemetryPolicyMock.applyTelemetryPolicy.mockImplementation((c: TelemetryConfig) => ({ ...c, enabled }))
	telemetryPolicyMock.enforceTelemetryEnabled.mockReturnValue(enabled)
}
