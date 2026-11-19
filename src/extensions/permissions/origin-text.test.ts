import { describe, expect, it } from "vitest"
import { sanitizeIdentity, sanitizePermissionOrigin } from "./origin-text.js"

describe("subagent permission identity text", () => {
	it("normalizes newlines and control characters to one printable line", () => {
		const value = sanitizeIdentity("review\nfiles\tcarefully\u0007\u001b[31m\u202e")
		expect(value).toBe("review files carefully [31m")
		expect(value).not.toMatch(/[\r\n\u0000-\u001f\u007f\u202e]/)
	})

	it("truncates long identity copy without splitting surrogate pairs", () => {
		const value = sanitizeIdentity(`${"a".repeat(150)}🔧`)
		expect(value).toBeDefined()
		expect(Array.from(value!).length).toBe(120)
		expect(value?.endsWith("…")).toBe(true)
	})

	it("preserves structured task identity while sanitizing the display fields", () => {
		const origin = sanitizePermissionOrigin({
			persona: "researcher\nsecondary",
			agentId: "worker-17",
			description: "  inspect\nconfiguration  ",
		})
		expect(origin).toEqual({ persona: "researcher secondary", agentId: "worker-17", description: "inspect configuration" })
		expect(sanitizePermissionOrigin(undefined)).toBeUndefined()
	})
})
