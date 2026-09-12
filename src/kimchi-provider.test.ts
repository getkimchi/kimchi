import { describe, expect, it } from "vitest"
import { isKimchiProvider } from "./kimchi-provider.js"

describe("isKimchiProvider", () => {
	it.each(["kimchi-dev", "kimchi-dev/openai", "kimchi-experimental"])("recognizes %s as Kimchi-managed", (provider) => {
		expect(isKimchiProvider(provider)).toBe(true)
	})

	it.each(["kimchi", "kimchi-development", "openai"])("does not match unrelated provider %s", (provider) => {
		expect(isKimchiProvider(provider)).toBe(false)
	})
})
