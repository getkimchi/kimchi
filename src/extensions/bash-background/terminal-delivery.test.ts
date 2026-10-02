import { describe, expect, it } from "vitest"
import { createTerminalDelivery } from "./terminal-delivery.js"

describe("createTerminalDelivery", () => {
	it("records an outcome as available with a stable identity", () => {
		const delivery = createTerminalDelivery()
		const pending = delivery.record("h1", "payload-1", "automatic")
		expect(pending.phase).toBe("available")
		expect(pending.owner).toBe("automatic")
		expect(pending.payload).toBe("payload-1")
		expect(pending.deliveryId).toBeTruthy()
		expect(delivery.hasPending()).toBe(true)
		expect(delivery.pendingHandles()).toEqual(["h1"])
		expect(delivery.getPending("h1")).toBe(pending)
	})

	it("claimControl claims only available automatic outcomes and never steals", () => {
		const delivery = createTerminalDelivery()
		delivery.record("h1", "p1", "automatic")
		// First control claim wins.
		expect(delivery.claimControl("h1", "call-a")).toBeDefined()
		// A second, different call cannot steal it.
		expect(delivery.claimControl("h1", "call-b")).toBeUndefined()
		// The owning call can re-read its own claim (idempotent delivery
		// within one call).
		expect(delivery.getPending("h1")?.owner).toEqual({ controlCallId: "call-a" })
		// releaseControl returns it to the automatic channel.
		expect(delivery.releaseControl("call-b")).toEqual([])
		expect(delivery.releaseControl("call-a")).toEqual(["h1"])
		expect(delivery.getPending("h1")?.owner).toBe("automatic")
	})

	it("markQueued is atomic per handle and assigns the batch delivery id", () => {
		const delivery = createTerminalDelivery()
		delivery.record("h1", "p1", "automatic")
		delivery.record("h2", "p2", "automatic")
		// A control claim on h2 blocks the automatic channel for it.
		delivery.claimControl("h2", "call-a")
		const queued1 = delivery.markQueued("h1", "batch-1")
		expect(queued1?.phase).toBe("queued")
		expect(queued1?.deliveryId).toBe("batch-1")
		// The control-claimed handle cannot be queued by the automatic channel.
		expect(delivery.markQueued("h2", "batch-1")).toBeUndefined()
		expect(delivery.getPending("h2")?.phase).toBe("available")
	})

	it("acknowledgeAutomatic retires every outcome of the batch delivery", () => {
		const delivery = createTerminalDelivery()
		delivery.record("h1", "p1", "automatic")
		delivery.record("h2", "p2", "automatic")
		delivery.markQueued("h1", "batch-1")
		delivery.markQueued("h2", "batch-1")
		expect(delivery.acknowledgeAutomatic("batch-1")).toBe("delivered")
		expect(delivery.hasPending()).toBe(false)
		// Idempotent for a second arrival of the same identity: superseded,
		// never delivered twice.
		expect(delivery.acknowledgeAutomatic("batch-1")).toBe("superseded")
	})

	it("acknowledgeAutomatic reports superseded when a control call delivered instead", () => {
		const delivery = createTerminalDelivery()
		delivery.record("h1", "p1", "automatic")
		delivery.markQueued("h1", "batch-1")
		// Abort-release then control claim (the recovery path).
		delivery.releaseAutomatic()
		delivery.claimControl("h1", "call-a")
		expect(delivery.acknowledgeAutomatic("batch-1")).toBe("superseded")
		// The pending stays for the control channel to retire.
		expect(delivery.getPending("h1")).toBeDefined()
	})

	it("acknowledgeAutomatic retires a late arrival after an abort-release (no control claim)", () => {
		const delivery = createTerminalDelivery()
		delivery.record("h1", "p1", "automatic")
		delivery.markQueued("h1", "batch-1")
		// Kimchi dropped the queue on abort; the message arrives late anyway
		// (a programmatic abort kept it). The payload IS in the conversation.
		delivery.releaseAutomatic()
		expect(delivery.acknowledgeAutomatic("batch-1")).toBe("delivered")
		expect(delivery.hasPending()).toBe(false)
	})

	it("releaseAutomatic returns only queued automatic outcomes to available", () => {
		const delivery = createTerminalDelivery()
		delivery.record("h1", "p1", "automatic")
		delivery.record("h2", "p2", "automatic")
		delivery.claimControl("h2", "call-a")
		delivery.markQueued("h1", "batch-1")
		expect(delivery.releaseAutomatic()).toEqual(["h1"])
		expect(delivery.getPending("h1")?.phase).toBe("available")
		expect(delivery.getPending("h1")?.owner).toBe("automatic")
		// Control claims are untouched by the abort release.
		expect(delivery.getPending("h2")?.owner).toEqual({ controlCallId: "call-a" })
	})

	it("acknowledgeControl retires handles idempotently", () => {
		const delivery = createTerminalDelivery()
		delivery.record("h1", "p1", { controlCallId: "call-a" })
		delivery.record("h2", "p2", "automatic")
		delivery.acknowledgeControl(["h1", "h2", "unknown"])
		expect(delivery.hasPending()).toBe(false)
		// Idempotent.
		expect(() => delivery.acknowledgeControl(["h1"])).not.toThrow()
	})

	it("releaseQueued rolls back exactly one batch to available", () => {
		const delivery = createTerminalDelivery()
		delivery.record("h1", "p1", "automatic")
		delivery.record("h2", "p2", "automatic")
		delivery.markQueued("h1", "batch-1")
		delivery.markQueued("h2", "batch-1")
		delivery.record("h3", "p3", "automatic")
		delivery.markQueued("h3", "batch-2")
		expect(delivery.releaseQueued("batch-1").sort()).toEqual(["h1", "h2"])
		expect(delivery.getPending("h1")?.phase).toBe("available")
		expect(delivery.getPending("h2")?.phase).toBe("available")
		// A different batch stays queued.
		expect(delivery.getPending("h3")?.phase).toBe("queued")
	})

	it("distinct sessions have distinct session identities", () => {
		expect(createTerminalDelivery().sessionId).not.toBe(createTerminalDelivery().sessionId)
	})
})
