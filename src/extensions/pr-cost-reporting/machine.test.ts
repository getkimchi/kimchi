import { describe, expect, it } from "vitest"
import { macMachineId, windowsMachineId } from "./machine.js"

describe("machine identity", () => {
	it("reads the hardware UUID from ioreg output", () => {
		const output = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000255, registered, matched, active, busy 0 (91 ms), retain 34>
    {
      "IOPlatformSerialNumber" = "ABC123"
      "IOPlatformUUID" = "4C4C4544-0032-3910-8044-B4C04F4B4D32"
    }`
		expect(macMachineId(output)).toBe("4C4C4544-0032-3910-8044-B4C04F4B4D32")
		expect(macMachineId("{}")).toBeUndefined()
	})

	it("reads MachineGuid from reg query output", () => {
		const output =
			"\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    6c0f0d8a-0c5e-4d6b-9a4b-0f1b2c3d4e5f\r\n"
		expect(windowsMachineId(output)).toBe("6c0f0d8a-0c5e-4d6b-9a4b-0f1b2c3d4e5f")
		expect(
			windowsMachineId("ERROR: The system was unable to find the specified registry key or value."),
		).toBeUndefined()
	})
})
