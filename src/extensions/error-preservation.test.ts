import { describe, expect, it } from "vitest"
import { getRawErrorMessage, hasPreservedRawErrorMessage, preserveRawErrorMessage } from "./error-preservation.js"

describe("preserveRawErrorMessage", () => {
	it("preserves the original errorMessage before mutation", () => {
		const message = { errorMessage: "InternalServerError: Hosted_vllmException - Cannot connect to host" }
		preserveRawErrorMessage(message)
		message.errorMessage = "Retrying…"
		expect(getRawErrorMessage(message)).toBe("InternalServerError: Hosted_vllmException - Cannot connect to host")
	})

	it("does not overwrite a previously preserved value", () => {
		const message = { errorMessage: "original error" }
		preserveRawErrorMessage(message)
		message.errorMessage = "Retrying…"
		preserveRawErrorMessage(message) // should be a no-op
		message.errorMessage = "Retrying… again"
		expect(getRawErrorMessage(message)).toBe("original error")
	})

	it("is a no-op when errorMessage is absent", () => {
		const message = {}
		preserveRawErrorMessage(message)
		expect(getRawErrorMessage(message)).toBeUndefined()
	})

	it("is a no-op when errorMessage is empty", () => {
		const message = { errorMessage: "" }
		preserveRawErrorMessage(message)
		expect(getRawErrorMessage(message)).toBe("")
	})

	it("stores the value as non-enumerable (not visible in serialization)", () => {
		const message = { errorMessage: "secret internal error" }
		preserveRawErrorMessage(message)
		message.errorMessage = "Retrying…"
		// JSON.stringify should not include the preserved value
		expect(JSON.stringify(message)).not.toContain("secret internal error")
		expect(JSON.stringify(message)).toContain("Retrying…")
		// Object.keys should not include the symbol
		expect(Object.keys(message)).toEqual(["errorMessage"])
	})

	it("falls back to current errorMessage when nothing was preserved", () => {
		const message = { errorMessage: "current error" }
		expect(getRawErrorMessage(message)).toBe("current error")
	})

	it("falls back to current errorMessage after mutation when nothing was preserved", () => {
		const message = { errorMessage: "original" }
		message.errorMessage = "mutated"
		expect(getRawErrorMessage(message)).toBe("mutated")
	})
})

describe("hasPreservedRawErrorMessage", () => {
	it("returns true only when preservation actually happened", () => {
		const message = { errorMessage: "raw error" }
		expect(hasPreservedRawErrorMessage(message)).toBe(false)
		preserveRawErrorMessage(message)
		expect(hasPreservedRawErrorMessage(message)).toBe(true)
	})

	it("returns false when errorMessage was absent (nothing to preserve)", () => {
		expect(hasPreservedRawErrorMessage({})).toBe(false)
	})

	it("returns false when errorMessage was empty (nothing preserved)", () => {
		expect(hasPreservedRawErrorMessage({ errorMessage: "" })).toBe(false)
	})
})
