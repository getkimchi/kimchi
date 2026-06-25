import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { EntryTrigger, EntryTriggerEvent, ModeState } from "./entry-trigger-registry.js"
import { clear, dispatch, has, register, size } from "./entry-trigger-registry.js"

describe("entry-trigger-registry", () => {
	beforeEach(() => {
		clear()
	})

	afterEach(() => {
		clear()
	})

	describe("register + dispatch", () => {
		it("returns mode state from registered trigger", () => {
			const trigger: EntryTrigger = () => ({
				kind: "enter-mode",
				mode: "adhoc",
				reason: "test trigger",
			})
			register("test-trigger", trigger)

			const event: EntryTriggerEvent = { kind: "cli-flag", name: "plan", present: true }
			const state = dispatch(event)

			expect(state.kind).toBe("enter-mode")
			if (state.kind === "enter-mode") {
				expect(state.mode).toBe("adhoc")
				expect(state.reason).toBe("test trigger")
			}
		})
	})

	describe("first non-noop wins", () => {
		it("skips noop and returns first non-noop trigger", () => {
			const trigger1: EntryTrigger = () => ({ kind: "noop" })
			const trigger2: EntryTrigger = () => ({
				kind: "enter-mode",
				mode: "adhoc",
				reason: "second trigger",
			})
			const trigger3: EntryTrigger = () => ({
				kind: "enter-mode",
				mode: "ferment",
				reason: "third trigger",
			})

			register("noop-trigger", trigger1)
			register("adhoc-trigger", trigger2)
			register("ferment-trigger", trigger3)

			const event: EntryTriggerEvent = { kind: "cli-flag", name: "plan", present: true }
			const state = dispatch(event)

			expect(state.kind).toBe("enter-mode")
			if (state.kind === "enter-mode") {
				expect(state.mode).toBe("adhoc")
				expect(state.reason).toBe("second trigger")
			}
		})
	})

	describe("reject short-circuits", () => {
		it("returns reject even if later trigger would accept", () => {
			const trigger1: EntryTrigger = () => ({ kind: "noop" })
			const trigger2: EntryTrigger = () => ({
				kind: "reject",
				reason: "rejected by trigger2",
			})
			const trigger3: EntryTrigger = () => ({
				kind: "enter-mode",
				mode: "adhoc",
				reason: "third trigger",
			})

			register("noop-trigger", trigger1)
			register("reject-trigger", trigger2)
			register("accept-trigger", trigger3)

			const event: EntryTriggerEvent = { kind: "cli-flag", name: "plan", present: true }
			const state = dispatch(event)

			expect(state.kind).toBe("reject")
			if (state.kind === "reject") {
				expect(state.reason).toBe("rejected by trigger2")
			}
		})
	})

	describe("all-noop returns noop", () => {
		it("returns noop when all triggers return noop", () => {
			const trigger1: EntryTrigger = () => ({ kind: "noop" })
			const trigger2: EntryTrigger = () => ({ kind: "noop" })

			register("noop1", trigger1)
			register("noop2", trigger2)

			const event: EntryTriggerEvent = { kind: "cli-flag", name: "plan", present: true }
			const state = dispatch(event)

			expect(state.kind).toBe("noop")
		})
	})

	describe("dispatch with no triggers", () => {
		it("returns noop when registry is empty", () => {
			const event: EntryTriggerEvent = { kind: "cli-flag", name: "plan", present: true }
			const state = dispatch(event)

			expect(state.kind).toBe("noop")
		})
	})

	describe("last-write-wins re-registration", () => {
		it("replaces trigger when same key is registered twice", () => {
			const trigger1: EntryTrigger = () => ({
				kind: "enter-mode",
				mode: "adhoc",
				reason: "first",
			})
			const trigger2: EntryTrigger = () => ({
				kind: "enter-mode",
				mode: "ferment",
				reason: "second",
			})

			register("same-key", trigger1)
			register("same-key", trigger2)

			const event: EntryTriggerEvent = { kind: "cli-flag", name: "plan", present: true }
			const state = dispatch(event)

			expect(state.kind).toBe("enter-mode")
			if (state.kind === "enter-mode") {
				expect(state.mode).toBe("ferment")
				expect(state.reason).toBe("second")
			}
		})
	})

	describe("clear()", () => {
		it("drops all registered triggers", () => {
			const trigger: EntryTrigger = () => ({ kind: "noop" })
			register("key", trigger)

			expect(size()).toBe(1)
			clear()
			expect(size()).toBe(0)

			const event: EntryTriggerEvent = { kind: "cli-flag", name: "plan", present: true }
			const state = dispatch(event)
			expect(state.kind).toBe("noop")
		})
	})

	describe("size()", () => {
		it("returns 0 when empty", () => {
			expect(size()).toBe(0)
		})

		it("returns count of registered triggers", () => {
			const trigger1: EntryTrigger = () => ({ kind: "noop" })
			const trigger2: EntryTrigger = () => ({ kind: "noop" })

			register("k1", trigger1)
			expect(size()).toBe(1)

			register("k2", trigger2)
			expect(size()).toBe(2)
		})

		it("does not grow when re-registering same key", () => {
			const trigger1: EntryTrigger = () => ({ kind: "noop" })
			const trigger2: EntryTrigger = () => ({ kind: "noop" })

			register("k", trigger1)
			expect(size()).toBe(1)

			register("k", trigger2)
			expect(size()).toBe(1)
		})
	})

	describe("has()", () => {
		it("returns true for registered key", () => {
			const trigger: EntryTrigger = () => ({ kind: "noop" })
			register("my-key", trigger)

			expect(has("my-key")).toBe(true)
		})

		it("returns false for unregistered key", () => {
			expect(has("nonexistent")).toBe(false)
		})

		it("returns false after clear", () => {
			const trigger: EntryTrigger = () => ({ kind: "noop" })
			register("my-key", trigger)
			clear()

			expect(has("my-key")).toBe(false)
		})
	})

	describe("invalid key throws", () => {
		it("throws when key is empty string", () => {
			const trigger: EntryTrigger = () => ({ kind: "noop" })
			expect(() => {
				register("", trigger)
			}).toThrow(/key must be a non-empty string/)
		})

		it("throws when key is null", () => {
			const trigger: EntryTrigger = () => ({ kind: "noop" })
			expect(() => {
				// biome-ignore lint/suspicious/noExplicitAny: testing invalid key error handling
				register(null as any, trigger)
			}).toThrow(/key must be a non-empty string/)
		})
	})

	describe("non-function trigger throws", () => {
		it("throws when trigger is not a function", () => {
			expect(() => {
				// biome-ignore lint/suspicious/noExplicitAny: testing invalid trigger error handling
				register("bad-trigger", "not a function" as any)
			}).toThrow(/trigger.*must be a function/)
		})
	})

	describe("cli-flag event", () => {
		// Review nit 3472299148: cli-flag splits flag presence (present) from
		// flag payload (value) so handlers never have to inspect `value === true`
		// to ask "was this flag supplied?".
		it("trigger receives cli-flag event payload (present-only boolean flag)", () => {
			let receivedEvent: EntryTriggerEvent | null = null
			const trigger: EntryTrigger = (event) => {
				receivedEvent = event
				return event.kind === "cli-flag" && event.name === "plan" && event.present
					? { kind: "enter-mode", mode: "adhoc", reason: "cli-flag" }
					: { kind: "noop" }
			}
			register("cli-flag-trigger", trigger)

			const event: EntryTriggerEvent = { kind: "cli-flag", name: "plan", present: true }
			const state = dispatch(event)

			expect(receivedEvent).toEqual(event)
			expect(state.kind).toBe("enter-mode")
		})

		it("trigger reads value separately from presence for value-bearing flags", () => {
			let receivedEvent: EntryTriggerEvent | null = null
			const trigger: EntryTrigger = (event) => {
				receivedEvent = event
				if (event.kind !== "cli-flag") return { kind: "noop" }
				if (!event.present) return { kind: "noop" }
				return event.value === "plan"
					? { kind: "enter-mode", mode: "adhoc", reason: `mode=${event.value}` }
					: { kind: "noop" }
			}
			register("cli-flag-value-trigger", trigger)

			const event: EntryTriggerEvent = { kind: "cli-flag", name: "mode", present: true, value: "plan" }
			const state = dispatch(event)

			expect(receivedEvent).toEqual(event)
			expect(state.kind).toBe("enter-mode")
			if (state.kind === "enter-mode") {
				expect(state.reason).toBe("mode=plan")
			}
		})
	})

	describe("key-press event", () => {
		it("trigger receives key-press event payload", () => {
			let receivedEvent: EntryTriggerEvent | null = null
			const trigger: EntryTrigger = (event) => {
				receivedEvent = event
				return event.kind === "key-press" && event.key === "shift+tab"
					? { kind: "switch-mode", mode: "ferment", reason: "key-press" }
					: { kind: "noop" }
			}
			register("key-press-trigger", trigger)

			const event: EntryTriggerEvent = { kind: "key-press", key: "shift+tab" }
			const state = dispatch(event)

			expect(receivedEvent).toEqual(event)
			expect(state.kind).toBe("switch-mode")
			if (state.kind === "switch-mode") {
				expect(state.mode).toBe("ferment")
			}
		})
	})

	describe("tool-call event", () => {
		it("trigger receives tool-call event payload", () => {
			let receivedEvent: EntryTriggerEvent | null = null
			const trigger: EntryTrigger = (event) => {
				receivedEvent = event
				return event.kind === "tool-call" && event.toolName === "questionnaire" && event.mode === "idle"
					? { kind: "enter-mode", mode: "adhoc", reason: "questionnaire" }
					: { kind: "noop" }
			}
			register("tool-call-trigger", trigger)

			const event: EntryTriggerEvent = {
				kind: "tool-call",
				toolName: "questionnaire",
				mode: "idle",
			}
			const state = dispatch(event)

			expect(receivedEvent).toEqual(event)
			expect(state.kind).toBe("enter-mode")
		})
	})

	describe("slash-command event", () => {
		// Review nit 3472304236: args is now a tokenised string[] so handlers
		// don't have to invent or duplicate their own splitting convention.
		it("trigger receives slash-command event payload with args as string[]", () => {
			let receivedEvent: EntryTriggerEvent | null = null
			const trigger: EntryTrigger = (event) => {
				receivedEvent = event
				return event.kind === "slash-command" && event.command === "ferment"
					? { kind: "enter-mode", mode: "ferment", reason: "slash-command" }
					: { kind: "noop" }
			}
			register("slash-command-trigger", trigger)

			const event: EntryTriggerEvent = {
				kind: "slash-command",
				command: "ferment",
				args: ["new", "MyFerment"],
			}
			const state = dispatch(event)

			expect(receivedEvent).toEqual(event)
			if (receivedEvent !== null) {
				const e = receivedEvent as EntryTriggerEvent
				if (e.kind === "slash-command") {
					expect(e.args).toEqual(["new", "MyFerment"])
				}
			}
			expect(state.kind).toBe("enter-mode")
		})
	})

	describe("env-var event", () => {
		it("trigger receives env-var event payload", () => {
			let receivedEvent: EntryTriggerEvent | null = null
			const trigger: EntryTrigger = (event) => {
				receivedEvent = event
				return event.kind === "env-var" && event.name === "KIMCHI_ACTIVE_FERMENT" && event.value
					? { kind: "enter-mode", mode: "ferment", reason: "env-var" }
					: { kind: "noop" }
			}
			register("env-var-trigger", trigger)

			const event: EntryTriggerEvent = {
				kind: "env-var",
				name: "KIMCHI_ACTIVE_FERMENT",
				value: "ferment-123",
			}
			const state = dispatch(event)

			expect(receivedEvent).toEqual(event)
			expect(state.kind).toBe("enter-mode")
		})

		it("trigger handles undefined env-var value", () => {
			let receivedEvent: EntryTriggerEvent | null = null
			const trigger: EntryTrigger = (event) => {
				receivedEvent = event
				return event.kind === "env-var" && event.value === undefined
					? { kind: "noop" }
					: { kind: "enter-mode", mode: "ferment", reason: "env-var" }
			}
			register("env-var-undefined-trigger", trigger)

			const event: EntryTriggerEvent = {
				kind: "env-var",
				name: "KIMCHI_ACTIVE_FERMENT",
				value: undefined,
			}
			const state = dispatch(event)

			expect(receivedEvent).toEqual(event)
			expect(state.kind).toBe("noop")
		})
	})

	describe("trigger can return different states based on event contents", () => {
		it("trigger returns enter-mode for one event, noop for another", () => {
			const trigger: EntryTrigger = (event) => {
				if (event.kind === "cli-flag" && event.name === "plan" && event.present) {
					return { kind: "enter-mode", mode: "adhoc", reason: "plan flag" }
				}
				if (event.kind === "cli-flag" && event.name === "ferment" && event.present) {
					return { kind: "enter-mode", mode: "ferment", reason: "ferment flag" }
				}
				return { kind: "noop" }
			}
			register("conditional-trigger", trigger)

			const planEvent: EntryTriggerEvent = { kind: "cli-flag", name: "plan", present: true }
			const planState = dispatch(planEvent)
			expect(planState.kind).toBe("enter-mode")
			if (planState.kind === "enter-mode") {
				expect(planState.mode).toBe("adhoc")
			}

			const fermentEvent: EntryTriggerEvent = { kind: "cli-flag", name: "ferment", present: true }
			const fermentState = dispatch(fermentEvent)
			expect(fermentState.kind).toBe("enter-mode")
			if (fermentState.kind === "enter-mode") {
				expect(fermentState.mode).toBe("ferment")
			}

			const otherEvent: EntryTriggerEvent = { kind: "cli-flag", name: "other", present: true }
			const otherState = dispatch(otherEvent)
			expect(otherState.kind).toBe("noop")
		})
	})
})
