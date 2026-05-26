import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that trigger module evaluation
// ---------------------------------------------------------------------------

vi.mock("../../config.js", () => ({
	readTelemetryConfig: vi.fn(),
}))

vi.mock("../../posthog-device.js", () => ({
	ensureDeviceId: vi.fn(),
}))

vi.mock("../../utils.js", () => ({
	getVersion: vi.fn(() => "1.0.0-test"),
}))

vi.mock("../../api/me.js", () => ({
	getMe: vi.fn(),
}))

// Mock the transport layer — we test the payload that `sendLog` receives
// rather than the raw fetch call, so we don't duplicate transport.test.ts.
vi.mock("./transport.js", () => ({
	sendLog: vi.fn(),
}))

import { getMe } from "../../api/me.js"
import { ensureDeviceId } from "../../posthog-device.js"
import { getVersion } from "../../utils.js"
import { _resetUserCache, drain, sendPreSessionEvent } from "./pre-session.js"
import { sendLog } from "./transport.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testDeviceId = randomUUID()
const testEndpoint = "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest"
const testHeaders = { Authorization: "Bearer test-key", "User-Agent": "kimchi/1.0.0-test" }

function makeConfig(overrides?: Record<string, unknown>) {
	return {
		enabled: true,
		endpoint: testEndpoint,
		metricsEndpoint: "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
		headers: testHeaders,
		apiKey: "test-key",
		...overrides,
	}
}

function lastSendLogCall() {
	const calls = vi.mocked(sendLog).mock.calls
	expect(calls.length).toBeGreaterThan(0)
	// biome-ignore lint/style/noNonNullAssertion: test helper — length checked above
	const lastCall = calls[calls.length - 1]!
	return {
		config: lastCall[0],
		sessionId: lastCall[1],
		eventName: lastCall[2],
		attrs: lastCall[3],
		userEmail: lastCall[4],
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendPreSessionEvent", () => {
	beforeEach(() => {
		_resetUserCache()
		vi.clearAllMocks()
		vi.mocked(ensureDeviceId).mockReturnValue(testDeviceId)
		vi.mocked(getVersion).mockReturnValue("1.0.0-test")
		vi.mocked(getMe).mockResolvedValue({ id: "user-123", email: "alice@cast.ai", name: "Alice" })
		vi.mocked(sendLog).mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	afterAll(() => {
		vi.restoreAllMocks()
	})

	it("calls sendLog with the correct event name and config", async () => {
		const config = makeConfig()
		sendPreSessionEvent(config, "app_started")
		await drain()

		expect(sendLog).toHaveBeenCalledOnce()
		const call = lastSendLogCall()
		expect(call.config).toBe(config)
		expect(call.eventName).toBe("app_started")
	})

	it("passes deviceId as the sessionId", async () => {
		sendPreSessionEvent(makeConfig(), "app_started")
		await drain()

		const call = lastSendLogCall()
		expect(call.sessionId).toBe(testDeviceId)
	})

	it("includes default telemetry attributes", async () => {
		sendPreSessionEvent(makeConfig(), "app_started")
		await drain()

		const { attrs } = lastSendLogCall()
		expect(attrs["telemetry.cli_version"]).toBe("1.0.0-test")
		expect(attrs["telemetry.os"]).toBe(process.platform)
		// arch mapping: x64 → amd64
		const expectedArch = process.arch === "x64" ? "amd64" : process.arch
		expect(attrs["telemetry.arch"]).toBe(expectedArch)
	})

	it("maps event properties to event.* attributes", async () => {
		sendPreSessionEvent(makeConfig(), "harness_launched", {
			version: "2.0.0",
			build: 42,
		})
		await drain()

		const { attrs } = lastSendLogCall()
		expect(attrs["event.version"]).toBe("2.0.0")
		expect(attrs["event.build"]).toBe(42)
	})

	it("includes userEmail from getMe", async () => {
		sendPreSessionEvent(makeConfig(), "app_started")
		await drain()

		const call = lastSendLogCall()
		expect(call.userEmail).toBe("alice@cast.ai")
	})

	it("includes user.account_uuid from getMe", async () => {
		sendPreSessionEvent(makeConfig(), "app_started")
		await drain()

		const { attrs } = lastSendLogCall()
		expect(attrs["user.account_uuid"]).toBe("user-123")
	})

	it("is a no-op when telemetry is disabled", async () => {
		sendPreSessionEvent(makeConfig({ enabled: false }), "app_started")
		await drain()

		expect(sendLog).not.toHaveBeenCalled()
	})

	it("is a no-op when no Authorization header is present", async () => {
		sendPreSessionEvent(makeConfig({ headers: { "User-Agent": "kimchi/1.0.0" }, apiKey: "" }), "app_started")
		await drain()

		expect(sendLog).not.toHaveBeenCalled()
	})

	it("sends without userEmail when getMe fails", async () => {
		vi.mocked(getMe).mockRejectedValue(new Error("network error"))

		sendPreSessionEvent(makeConfig(), "app_started")
		await drain()

		expect(sendLog).toHaveBeenCalledOnce()
		const call = lastSendLogCall()
		expect(call.userEmail).toBeUndefined()
		expect(call.attrs["user.account_uuid"]).toBeUndefined()
	})

	it("sends without userEmail when getMe returns no email", async () => {
		vi.mocked(getMe).mockResolvedValue({ id: "user-123" })

		sendPreSessionEvent(makeConfig(), "app_started")
		await drain()

		expect(sendLog).toHaveBeenCalledOnce()
		const call = lastSendLogCall()
		expect(call.userEmail).toBeUndefined()
		expect(call.attrs["user.account_uuid"]).toBe("user-123")
	})

	it("caches user identity — getMe called only once across multiple events", async () => {
		const config = makeConfig()
		sendPreSessionEvent(config, "app_started")
		await drain()
		sendPreSessionEvent(config, "harness_launched")
		await drain()

		expect(getMe).toHaveBeenCalledTimes(1)
		expect(sendLog).toHaveBeenCalledTimes(2)

		// Both calls should have the cached email
		const calls = vi.mocked(sendLog).mock.calls
		expect(calls[0]?.[4]).toBe("alice@cast.ai")
		expect(calls[1]?.[4]).toBe("alice@cast.ai")
	})

	it("does not retry getMe after failure (caches the failure)", async () => {
		vi.mocked(getMe).mockRejectedValue(new Error("network error"))

		const config = makeConfig()
		sendPreSessionEvent(config, "app_started")
		await drain()
		sendPreSessionEvent(config, "harness_launched")
		await drain()

		// getMe should only be called once — the failure is cached
		expect(getMe).toHaveBeenCalledTimes(1)
		expect(sendLog).toHaveBeenCalledTimes(2)
	})

	it("handles concurrent calls before getMe resolves", async () => {
		let resolveGetMe: (value: { id: string; email: string }) => void = () => {}
		vi.mocked(getMe).mockReturnValue(
			new Promise((resolve) => {
				resolveGetMe = resolve
			}),
		)

		const config = makeConfig()
		sendPreSessionEvent(config, "app_started")
		sendPreSessionEvent(config, "harness_launched")

		// Resolve getMe after both events are in flight
		resolveGetMe({ id: "user-123", email: "alice@cast.ai" })
		await drain()

		// Only one getMe call despite two events
		expect(getMe).toHaveBeenCalledTimes(1)
		expect(sendLog).toHaveBeenCalledTimes(2)

		// Both should have the email
		const calls = vi.mocked(sendLog).mock.calls
		expect(calls[0]?.[4]).toBe("alice@cast.ai")
		expect(calls[1]?.[4]).toBe("alice@cast.ai")
	})

	it("handles setup_completed with tools_count and scope", async () => {
		sendPreSessionEvent(makeConfig(), "setup_completed", {
			tools_count: 3,
			scope: "global",
		})
		await drain()

		const { attrs, eventName } = lastSendLogCall()
		expect(eventName).toBe("setup_completed")
		expect(attrs["event.tools_count"]).toBe(3)
		expect(attrs["event.scope"]).toBe("global")
	})

	it("uses 'unknown' as sessionId when ensureDeviceId returns empty string", async () => {
		vi.mocked(ensureDeviceId).mockReturnValue("")

		sendPreSessionEvent(makeConfig(), "app_started")
		await drain()

		const call = lastSendLogCall()
		expect(call.sessionId).toBe("unknown")
	})

	it("swallows sendLog errors and does not throw", async () => {
		vi.mocked(sendLog).mockRejectedValue(new Error("network error"))

		sendPreSessionEvent(makeConfig(), "app_started")
		// drain should not throw
		await expect(drain()).resolves.toBeUndefined()
	})

	it("does not include event.name collision with user properties named 'name'", async () => {
		// Properties get prefixed with "event.", so { name: "foo" } becomes "event.name".
		// This is fine because the server reads event name from the body/eventName field,
		// not from attributes. But we should document the behavior.
		sendPreSessionEvent(makeConfig(), "app_started", { name: "foo" })
		await drain()

		const { attrs } = lastSendLogCall()
		// The transport's sendLog puts event name in the body/eventName field.
		// User properties go into attrs with event.* prefix.
		expect(attrs["event.name"]).toBe("foo")
	})
})

describe("drain", () => {
	beforeEach(() => {
		_resetUserCache()
		vi.clearAllMocks()
		vi.mocked(ensureDeviceId).mockReturnValue(testDeviceId)
		vi.mocked(getVersion).mockReturnValue("1.0.0-test")
		vi.mocked(getMe).mockResolvedValue({ id: "user-123", email: "alice@cast.ai", name: "Alice" })
		vi.mocked(sendLog).mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("resolves immediately when no events are pending", async () => {
		await expect(drain()).resolves.toBeUndefined()
	})

	it("waits for pending events to settle", async () => {
		let resolveSendLog: () => void = () => {}
		vi.mocked(sendLog).mockReturnValue(
			new Promise<void>((resolve) => {
				resolveSendLog = resolve
			}),
		)

		sendPreSessionEvent(makeConfig(), "app_started")

		const drainPromise = drain()
		resolveSendLog()
		await expect(drainPromise).resolves.toBeUndefined()
	})
})
