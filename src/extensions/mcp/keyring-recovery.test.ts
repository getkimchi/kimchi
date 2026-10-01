import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configureMcpKeyringRecoveryHelper, MCP_KEYRING_HELPER_COMMAND } from "./keyring-recovery.js"

const runtime = vi.hoisted(() => ({ isBunBinary: true }))
vi.mock("../../env.js", () => runtime)

const NODE_ENV = "PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE"
const HELPER_ENV = "PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER"

describe("configureMcpKeyringRecoveryHelper", () => {
	beforeEach(() => {
		runtime.isBunBinary = true
		vi.spyOn(process, "platform", "get").mockReturnValue("linux")
		vi.stubEnv(NODE_ENV, "")
		vi.stubEnv(HELPER_ENV, "")
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it("launches the current executable in helper mode on compiled Linux", () => {
		configureMcpKeyringRecoveryHelper()
		expect(process.env[NODE_ENV]).toBe(process.execPath)
		expect(process.env[HELPER_ENV]).toBe(MCP_KEYRING_HELPER_COMMAND)
		configureMcpKeyringRecoveryHelper()
		expect(process.env[HELPER_ENV]).toBe(MCP_KEYRING_HELPER_COMMAND)
	})

	it.each([NODE_ENV, HELPER_ENV])("preserves an explicit %s override", (name) => {
		vi.stubEnv(name, "/custom/override")
		configureMcpKeyringRecoveryHelper()
		expect(process.env[name]).toBe("/custom/override")
		expect(process.env[name === NODE_ENV ? HELPER_ENV : NODE_ENV]).toBe("")
	})

	it("leaves source runs using the adapter's installed helper", () => {
		runtime.isBunBinary = false
		configureMcpKeyringRecoveryHelper()
		expect(process.env[NODE_ENV]).toBe("")
		expect(process.env[HELPER_ENV]).toBe("")
	})

	it.each(["darwin", "win32"] as const)("does not enable Linux recovery on %s", (platform) => {
		vi.spyOn(process, "platform", "get").mockReturnValue(platform)
		configureMcpKeyringRecoveryHelper()
		expect(process.env[NODE_ENV]).toBe("")
		expect(process.env[HELPER_ENV]).toBe("")
	})
})
