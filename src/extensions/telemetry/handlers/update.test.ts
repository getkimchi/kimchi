import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { logEvents } from "./../otlp-test-utils.js"
import { TelemetryContext } from "./../session-context.js"
import { handleUpdateTick, UPDATE_TICK_EVENT } from "./update.js"

function makeConfig(): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "http://localhost:4318/v1/logs",
		metricsEndpoint: "http://localhost:4318/v1/metrics",
		headers: {},
		apiKey: "",
	}
}

describe("handleUpdateTick", () => {
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	function emittedEventNames(): string[] {
		return logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).map((e) => e.eventName)
	}

	/** flushLogBuffer() hands off to the transport asynchronously; wait for
	 *  the tick event to land in the mocked fetch before asserting. */
	async function tickEvent() {
		let event: ReturnType<typeof logEvents>[number] | undefined
		await vi.waitFor(() => {
			event = logEvents(globalThis.fetch as ReturnType<typeof vi.fn>).find((e) => e.eventName === UPDATE_TICK_EVENT)
			expect(event).toBeDefined()
		})
		return event as NonNullable<typeof event>
	}

	it("emits update.tick with the outcome for a no-update tick", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleUpdateTick(ctx, { outcome: "no-update" })
		ctx.flushLogBuffer()

		const event = await tickEvent()
		expect(event.attrs.outcome).toBe("no-update")
		expect(event.attrs.update_version).toBeUndefined()
	})

	it("stamps the target version for installed outcomes", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleUpdateTick(ctx, { outcome: "installed", version: "v0.0.23" })
		ctx.flushLogBuffer()

		const event = await tickEvent()
		expect(event.attrs.outcome).toBe("installed")
		expect(event.attrs.update_version).toBe("v0.0.23")
	})

	it("carries the truncated failure reason for failed outcomes", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleUpdateTick(ctx, { outcome: "install-failed", version: "v0.0.23", error: "checksum mismatch" })
		ctx.flushLogBuffer()

		const event = await tickEvent()
		expect(event.attrs.error).toBe("checksum mismatch")
	})

	it("omits empty optional attributes", async () => {
		const ctx = new TelemetryContext(makeConfig())
		handleUpdateTick(ctx, { outcome: "skipped-lock", error: "" })
		ctx.flushLogBuffer()

		const event = await tickEvent()
		expect(event.attrs.outcome).toBe("skipped-lock")
		expect(event.attrs.error).toBeUndefined()
	})

	it("drops out-of-contract payloads without emitting", () => {
		const ctx = new TelemetryContext(makeConfig())
		handleUpdateTick(ctx, { outcome: "surprise" })
		handleUpdateTick(ctx, null)
		handleUpdateTick(ctx, 42)
		ctx.flushLogBuffer()

		expect(emittedEventNames()).not.toContain(UPDATE_TICK_EVENT)
	})
})
