import { afterEach, expect, it, vi } from "vitest"
import { isAcpSessionHost } from "../../modes/acp/state.js"
import { isPRMonitoringPermitted, setPRMonitoringPermitted } from "./session-policy.js"

vi.mock("../../modes/acp/state.js", () => ({ isAcpSessionHost: vi.fn() }))

afterEach(() => setPRMonitoringPermitted(false))

it.each([true, false])("ACP host=%s only requires the negotiated policy under ACP", (acp) => {
	vi.mocked(isAcpSessionHost).mockReturnValue(acp)
	expect(isPRMonitoringPermitted()).toBe(!acp)
	setPRMonitoringPermitted(true)
	expect(isPRMonitoringPermitted()).toBe(true)
	setPRMonitoringPermitted(false)
	expect(isPRMonitoringPermitted()).toBe(!acp)
})
