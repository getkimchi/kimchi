import { beforeEach, describe, expect, it } from "vitest"
import { clearSecrets, getSecret, storeSecret, substituteSecrets } from "./secrets-store.js"

describe("secrets-store", () => {
	beforeEach(() => clearSecrets())

	it("stores and retrieves a secret", () => {
		storeSecret("api_key", "shh")
		expect(getSecret("api_key")).toBe("shh")
	})

	it("returns undefined for unknown id", () => {
		expect(getSecret("nope")).toBeUndefined()
	})

	it("clears all secrets", () => {
		storeSecret("a", "1")
		clearSecrets()
		expect(getSecret("a")).toBeUndefined()
	})

	describe("substituteSecrets", () => {
		it("replaces a known placeholder", () => {
			storeSecret("api_key", "real123")
			expect(substituteSecrets("key=${kimchi_secret:api_key}")).toBe("key=real123")
		})

		it("replaces multiple placeholders", () => {
			storeSecret("a", "1")
			storeSecret("b", "2")
			expect(substituteSecrets("${kimchi_secret:a} ${kimchi_secret:b}")).toBe("1 2")
		})

		it("leaves unknown placeholders intact", () => {
			storeSecret("a", "1")
			expect(substituteSecrets("${kimchi_secret:a} ${kimchi_secret:b}")).toBe("1 ${kimchi_secret:b}")
		})

		it("does not match invalid characters in id", () => {
			storeSecret("api_key", "real")
			expect(substituteSecrets("${kimchi_secret:api key}")).toBe("${kimchi_secret:api key}")
		})
	})
})
