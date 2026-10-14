import { afterEach, describe, expect, it, vi } from "vitest"
import { drain as drainPreSessionTelemetry, sendPreSessionEvent } from "../extensions/telemetry/pre-session.js"
import { resetOrgPolicyForTests } from "../org-policy.js"
import { setOrgPolicyForTests } from "../org-policy.test-utils.js"
import { runWizard } from "../setup-wizard/index.js"
import { runSetup } from "./setup.js"

vi.mock("../setup-wizard/index.js", () => ({
	runWizard: vi.fn(),
}))

vi.mock("../extensions/telemetry/pre-session.js", () => ({
	drain: vi.fn(),
	sendPreSessionEvent: vi.fn(),
}))

const mockRunWizard = vi.mocked(runWizard)
const mockSendPreSessionEvent = vi.mocked(sendPreSessionEvent)
const mockDrain = vi.mocked(drainPreSessionTelemetry)

const wizardCompleted = {
	cancelled: false,
	selectedTools: ["opencode"],
	configuredTools: [],
	scope: "global",
} as Awaited<ReturnType<typeof runWizard>>

describe("runSetup telemetry policy", () => {
	afterEach(() => {
		vi.clearAllMocks()
		vi.unstubAllEnvs()
		resetOrgPolicyForTests()
	})

	it("reports setup_completed when telemetry is opted in and no policy applies", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		mockRunWizard.mockResolvedValue(wizardCompleted)

		await expect(runSetup([])).resolves.toBe(0)

		expect(mockRunWizard).toHaveBeenCalledOnce()
		expect(mockSendPreSessionEvent).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: true }),
			"setup_completed",
			{ tools_count: 1, scope: "global" },
		)
		expect(mockDrain).toHaveBeenCalledOnce()
	})

	it("sends no pre-session events under FORCE_OFF even when the user opted in", async () => {
		await setOrgPolicyForTests({ usageReporting: "FORCE_OFF" })
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		mockRunWizard.mockResolvedValue(wizardCompleted)

		await expect(runSetup([])).resolves.toBe(0)

		expect(mockRunWizard).toHaveBeenCalledOnce()
		expect(mockSendPreSessionEvent).not.toHaveBeenCalled()
		expect(mockDrain).not.toHaveBeenCalled()
	})

	it("sends setup_aborted when the wizard is cancelled with telemetry enabled", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		mockRunWizard.mockResolvedValue({
			cancelled: true,
			cancelledStep: "tools",
			selectedTools: [],
			configuredTools: [],
		} as Awaited<ReturnType<typeof runWizard>>)

		await expect(runSetup([])).resolves.toBe(130)

		expect(mockSendPreSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }), "setup_aborted", {
			step: "tools",
		})
		expect(mockDrain).toHaveBeenCalledOnce()
	})
})
