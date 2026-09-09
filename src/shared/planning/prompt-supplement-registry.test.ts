import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { PromptBlock } from "./prompt-supplement-registry.js"
import { clear, compose, has, register, size } from "./prompt-supplement-registry.js"

describe("prompt-supplement-registry", () => {
	beforeEach(() => {
		clear()
	})

	afterEach(() => {
		clear()
	})

	describe("register + compose for adhoc mode", () => {
		it("returns block registered for adhoc mode when composing adhoc", () => {
			const block: PromptBlock = {
				id: "test-adhoc",
				render: () => "adhoc content",
			}
			register("adhoc-only", block, { modes: ["adhoc"] })

			const adhocBlocks = compose("adhoc")
			expect(adhocBlocks).toHaveLength(1)
			expect(adhocBlocks[0]).toBe(block)
		})

		it("excludes block from ferment compose when registered for adhoc only", () => {
			const block: PromptBlock = {
				id: "test-adhoc",
				render: () => "adhoc content",
			}
			register("adhoc-only", block, { modes: ["adhoc"] })

			const fermentBlocks = compose("ferment")
			expect(fermentBlocks).toHaveLength(0)
		})
	})

	describe("register + compose for ferment mode", () => {
		it("returns block registered for ferment mode when composing ferment", () => {
			const block: PromptBlock = {
				id: "test-ferment",
				render: () => "ferment content",
			}
			register("ferment-only", block, { modes: ["ferment"] })

			const fermentBlocks = compose("ferment")
			expect(fermentBlocks).toHaveLength(1)
			expect(fermentBlocks[0]).toBe(block)
		})

		it("excludes block from adhoc compose when registered for ferment only", () => {
			const block: PromptBlock = {
				id: "test-ferment",
				render: () => "ferment content",
			}
			register("ferment-only", block, { modes: ["ferment"] })

			const adhocBlocks = compose("adhoc")
			expect(adhocBlocks).toHaveLength(0)
		})
	})

	describe("register with no modes arg", () => {
		it("defaults to both modes", () => {
			const block: PromptBlock = {
				id: "test-both",
				render: () => "both modes content",
			}
			register("both-default", block)

			const adhocBlocks = compose("adhoc")
			const fermentBlocks = compose("ferment")

			expect(adhocBlocks).toHaveLength(1)
			expect(adhocBlocks[0]).toBe(block)
			expect(fermentBlocks).toHaveLength(1)
			expect(fermentBlocks[0]).toBe(block)
		})
	})

	describe("register with both modes explicit", () => {
		it("appears in both compose results", () => {
			const block: PromptBlock = {
				id: "test-explicit-both",
				render: () => "explicit both",
			}
			register("both-explicit", block, { modes: ["adhoc", "ferment"] })

			const adhocBlocks = compose("adhoc")
			const fermentBlocks = compose("ferment")

			expect(adhocBlocks).toHaveLength(1)
			expect(adhocBlocks[0]).toBe(block)
			expect(fermentBlocks).toHaveLength(1)
			expect(fermentBlocks[0]).toBe(block)
		})
	})

	describe("last-write-wins re-registration", () => {
		it("replaces block when same key is registered twice", () => {
			const block1: PromptBlock = {
				id: "first-id",
				render: () => "first",
			}
			const block2: PromptBlock = {
				id: "second-id",
				render: () => "second",
			}

			register("duplicate-key", block1, { modes: ["adhoc"] })
			register("duplicate-key", block2, { modes: ["adhoc"] })

			const adhocBlocks = compose("adhoc")
			expect(adhocBlocks).toHaveLength(1)
			expect(adhocBlocks[0].id).toBe("second-id")
		})
	})

	describe("compose preserves registration order", () => {
		it("returns blocks in insertion order", () => {
			const block1: PromptBlock = { id: "first", render: () => "1" }
			const block2: PromptBlock = { id: "second", render: () => "2" }
			const block3: PromptBlock = { id: "third", render: () => "3" }

			register("key1", block1, { modes: ["adhoc"] })
			register("key2", block2, { modes: ["adhoc"] })
			register("key3", block3, { modes: ["adhoc"] })

			const adhocBlocks = compose("adhoc")
			expect(adhocBlocks).toHaveLength(3)
			expect(adhocBlocks[0].id).toBe("first")
			expect(adhocBlocks[1].id).toBe("second")
			expect(adhocBlocks[2].id).toBe("third")
		})
	})

	describe("clear()", () => {
		it("drops all registered blocks", () => {
			const block: PromptBlock = { id: "test", render: () => "test" }
			register("key", block)

			expect(size()).toBe(1)
			clear()
			expect(size()).toBe(0)

			const adhocBlocks = compose("adhoc")
			const fermentBlocks = compose("ferment")
			expect(adhocBlocks).toHaveLength(0)
			expect(fermentBlocks).toHaveLength(0)
		})
	})

	describe("has()", () => {
		it("returns true for registered key", () => {
			const block: PromptBlock = { id: "test", render: () => "test" }
			register("my-key", block)

			expect(has("my-key")).toBe(true)
		})

		it("returns false for unregistered key", () => {
			expect(has("nonexistent")).toBe(false)
		})

		it("returns false after clear", () => {
			const block: PromptBlock = { id: "test", render: () => "test" }
			register("my-key", block)
			clear()

			expect(has("my-key")).toBe(false)
		})
	})

	describe("invalid mode throws", () => {
		it("throws when registering with invalid mode", () => {
			const block: PromptBlock = { id: "test", render: () => "test" }
			expect(() => {
				// biome-ignore lint/suspicious/noExplicitAny: testing invalid mode error handling
				register("bad-mode", block, { modes: ["invalid" as any] })
			}).toThrow(/invalid mode/)
		})
	})

	describe("compose with invalid mode throws", () => {
		it("throws when composing with invalid mode", () => {
			expect(() => {
				// biome-ignore lint/suspicious/noExplicitAny: testing invalid mode error handling
				compose("invalid" as any)
			}).toThrow(/invalid mode/)
		})
	})

	describe("block isolation", () => {
		it("returns distinct blocks for different keys with same mode", () => {
			const block1: PromptBlock = { id: "block1", render: () => "content1" }
			const block2: PromptBlock = { id: "block2", render: () => "content2" }

			register("key1", block1, { modes: ["adhoc"] })
			register("key2", block2, { modes: ["adhoc"] })

			const adhocBlocks = compose("adhoc")
			expect(adhocBlocks).toHaveLength(2)
			expect(adhocBlocks[0]).toBe(block1)
			expect(adhocBlocks[1]).toBe(block2)
		})
	})

	describe("block render is callable through compose", () => {
		it("confirms render can be called on composed block", () => {
			const block: PromptBlock = {
				id: "test-render",
				render: (ctx) => `mode: ${ctx.mode}`,
			}
			register("test-key", block, { modes: ["adhoc"] })

			const adhocBlocks = compose("adhoc")
			const rendered = adhocBlocks[0].render({ mode: "orchestrator" })
			expect(rendered).toBe("mode: orchestrator")
		})

		it("confirms suppress can be called on composed block", () => {
			const block: PromptBlock = {
				id: "test-suppress",
				render: () => "content",
				suppress: () => new Set(["orchestration" as const]),
			}
			register("test-key", block, { modes: ["ferment"] })

			const fermentBlocks = compose("ferment")
			const suppressSet = fermentBlocks[0].suppress?.({ mode: "orchestrator" })
			expect(suppressSet).toBeInstanceOf(Set)
			expect(suppressSet?.has("orchestration")).toBe(true)
		})
	})

	describe("size()", () => {
		it("returns 0 when empty", () => {
			expect(size()).toBe(0)
		})

		it("returns count of registered blocks", () => {
			const block1: PromptBlock = { id: "b1", render: () => "1" }
			const block2: PromptBlock = { id: "b2", render: () => "2" }

			register("k1", block1)
			expect(size()).toBe(1)

			register("k2", block2)
			expect(size()).toBe(2)
		})

		it("does not grow when re-registering same key", () => {
			const block1: PromptBlock = { id: "b1", render: () => "1" }
			const block2: PromptBlock = { id: "b2", render: () => "2" }

			register("k", block1)
			expect(size()).toBe(1)

			register("k", block2)
			expect(size()).toBe(1)
		})
	})
})
