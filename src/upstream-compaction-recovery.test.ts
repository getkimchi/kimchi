import { AgentSession } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { getRawErrorMessage, preserveRawErrorMessage } from "./extensions/error-preservation.js"
import { installCompactionRecoveryPatch } from "./upstream-retry-patch.js"

/**
 * Raw moonshot-style over-limit error as returned by the gateway (and as
 * matched by pi-ai's OVERFLOW_PATTERNS "input (N tokens) is longer than").
 */
const RAW_OVERFLOW =
	'{"error":{"type":"invalid_request_error","message":"The input (313972 tokens) is longer than the model\'s context length (262144 tokens).","retryable":false,"code":"400"}}'

/** Sanitized display text the interactive-error-surface writes over the raw error. */
const SANITIZED_OVERFLOW = "The request could not be completed (context window exceeded). Please retry your request."

type CheckCompaction = (message: Record<string, unknown>, skipAbortedCheck?: boolean) => Promise<boolean>

type FakeSessionPrototype = {
	_checkCompaction?: CheckCompaction
	_kimchiCompactionRecoveryPatch?: boolean
}

function createPatchedClass(original: CheckCompaction): { prototype: FakeSessionPrototype } {
	const sessionClass = { prototype: { _checkCompaction: original } as FakeSessionPrototype }
	installCompactionRecoveryPatch(sessionClass as never)
	return sessionClass
}

/** Nontrivial unwrap so tests avoid biome-forbidden non-null assertions. */
function patchedCheckCompaction(cls: { prototype: FakeSessionPrototype }): CheckCompaction {
	const fn = cls.prototype._checkCompaction
	if (!fn) throw new Error("expected _checkCompaction to be installed")
	return fn
}

describe("installCompactionRecoveryPatch", () => {
	it("upstream still exposes the _checkCompaction hook the patch wraps", () => {
		// The patch wraps a private upstream method. If upstream renames or removes
		// it, this must fail loudly instead of silently disabling recovery.
		const proto = (AgentSession as unknown as { prototype: Record<string, unknown> }).prototype
		expect(typeof proto._checkCompaction).toBe("function")
	})

	it("passes through untouched when the message has no errorMessage (no string → identity call)", async () => {
		const original = vi.fn<CheckCompaction>(async () => false)
		const cls = createPatchedClass(original)
		const msg = { role: "assistant", stopReason: "stop" }

		await patchedCheckCompaction(cls)(msg, false)

		expect(original).toHaveBeenCalledTimes(1)
		expect(original.mock.calls[0][0]).toBe(msg)
		expect(original.mock.calls[0][1]).toBe(false)
	})

	it("wraps once (re-installing does not double-wrap)", () => {
		const original = vi.fn<CheckCompaction>(async () => false)
		const sessionClass = { prototype: { _checkCompaction: original } as FakeSessionPrototype }
		installCompactionRecoveryPatch(sessionClass as never)
		const wrapped = sessionClass.prototype._checkCompaction
		installCompactionRecoveryPatch(sessionClass as never)
		expect(sessionClass.prototype._checkCompaction).toBe(wrapped)
	})

	it("installing when the hook is missing is a safe no-op", () => {
		const empty = { prototype: {} as FakeSessionPrototype }
		expect(() => installCompactionRecoveryPatch(empty as never)).not.toThrow()
		expect(empty.prototype._checkCompaction).toBeUndefined()
	})

	it("restores the preserved raw error on a fresh copy before calling (display text untouched)", async () => {
		const captured: Record<string, unknown>[] = []
		const original = vi.fn<CheckCompaction>(async (message) => {
			captured.push(message)
			return true
		})
		const cls = createPatchedClass(original)

		const message: Record<string, unknown> = {
			role: "assistant",
			stopReason: "error",
			errorMessage: RAW_OVERFLOW,
			provider: "kimchi-dev",
			model: "kimi-k2.7",
		}
		// Simulate interactive-error-surface sanitizing the message.
		preserveRawErrorMessage(message)
		message.errorMessage = SANITIZED_OVERFLOW

		await patchedCheckCompaction(cls)(message)

		expect(captured).toHaveLength(1)
		expect(captured[0].errorMessage).toBe(RAW_OVERFLOW)
		// The visible message keeps its sanitized display text.
		expect(message.errorMessage).toBe(SANITIZED_OVERFLOW)
		// The copy does not alias the original message.
		expect(captured[0]).not.toBe(message)
	})

	it("does not change the call when the message already carries the raw error (no sanitize happened)", async () => {
		const original = vi.fn<CheckCompaction>(async () => false)
		const cls = createPatchedClass(original)
		const msg = { role: "assistant", stopReason: "error", errorMessage: RAW_OVERFLOW }

		// In production _checkCompaction is always called as session._checkCompaction(msg),
		// so `this` is the session. Bind a minimal stub with no sessionManager →
		// branch scan returns [] → no raw found → identity pass-through.
		await patchedCheckCompaction(cls).call({ sessionManager: undefined } as never, msg)

		expect(original.mock.calls[0][0]).toBe(msg)
	})
})

describe("end-to-end overflow recovery through the real upstream method", () => {
	/**
	 * Drives the REAL AgentSession.prototype._checkCompaction through the
	 * installed patch against a hand-rolled session — the closest unit-level
	 * simulation of `_handlePostAgentRun` we can build without pi-mono's full
	 * agent runnable. Asserts the compact-and-retry branch fires exactly when
	 * the raw overflow is visible, and skips it when only the sanitized text is.
	 */
	function buildRealishSession(opts: {
		compactionCalls: Array<{ reason: string; willRetry: boolean }>
		agentMessages: Array<Record<string, unknown>>
	}) {
		const { compactionCalls, agentMessages } = opts
		return {
			settingsManager: {
				getCompactionSettings: () => ({ enabled: true }),
			},
			model: {
				provider: "kimchi-dev",
				id: "kimi-k2.7",
				contextWindow: 262_144,
				maxTokens: 131_072,
			},
			sessionManager: {
				getBranch: () => [],
				getSessionFile: () => "/tmp/fake.jsonl",
			},
			agent: { state: { messages: agentMessages } },
			_overflowRecoveryAttempted: false,
			_runAutoCompaction: vi.fn(async (reason: string, willRetry: boolean) => {
				compactionCalls.push({ reason, willRetry })
				return true
			}),
			_emit: vi.fn(),
		}
	}

	function realCheckCompaction(session: unknown, message: Record<string, unknown>): Promise<boolean> {
		const proto = AgentSession.prototype as unknown as Record<string, CheckCompaction>
		return proto._checkCompaction.call(session, message)
	}

	it("skips overflow recovery when only the sanitized text is visible (regression witness)", async () => {
		const compactionCalls: Array<{ reason: string; willRetry: boolean }> = []
		const agentMessages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: SANITIZED_OVERFLOW,
				content: [],
				timestamp: Date.now(),
			},
		]
		const session = buildRealishSession({ compactionCalls, agentMessages })

		const ran = await realCheckCompaction(session, agentMessages[1])

		expect(ran).toBe(false)
		expect(compactionCalls).toHaveLength(0)
	})

	it("fires overflow compact-and-retry when the raw error is preserved (the fix)", async () => {
		const compactionCalls: Array<{ reason: string; willRetry: boolean }> = []
		const failingMessage: Record<string, unknown> = {
			role: "assistant",
			stopReason: "error",
			errorMessage: RAW_OVERFLOW,
			provider: "kimchi-dev",
			model: "kimi-k2.7",
			content: [],
			timestamp: Date.now(),
		}
		preserveRawErrorMessage(failingMessage)
		failingMessage.errorMessage = SANITIZED_OVERFLOW

		const agentMessages = [{ role: "user", content: [{ type: "text", text: "hi" }] }, failingMessage]
		const session = buildRealishSession({ compactionCalls, agentMessages })

		// Install on the REAL AgentSession class to prove the patched path flows,
		// then put the exact original back so later tests in this process see
		// unpatched upstream behavior.
		const proto = AgentSession.prototype as unknown as Record<string, CheckCompaction | undefined>
		const originalBeforeInstall = proto._checkCompaction
		installCompactionRecoveryPatch()
		let ran = false
		try {
			const patched = proto._checkCompaction
			if (!patched) throw new Error("expected _checkCompaction to be installed")
			ran = await patched.call(session, failingMessage)
		} finally {
			proto._checkCompaction = originalBeforeInstall
		}
		expect(ran).toBe(true)

		expect(compactionCalls).toHaveLength(1)
		expect(compactionCalls[0]).toEqual({ reason: "overflow", willRetry: true })
		// The failed message is removed from agent state before the retry.
		// (Upstream reassigns agent.state.messages = messages.slice(0, -1), so
		// assert on the session's current array, not the old reference.)
		const current = (session as { agent: { state: { messages: unknown[] } } }).agent.state.messages
		expect(current).toHaveLength(1)
		expect((current[0] as { role?: string }).role).toBe("user")
	})
})

describe("resume path: raw error recovered from session audit entries", () => {
	it("finds the most recent rawMessage from kimchi_error_classification audit entries when the symbol is gone", async () => {
		const captured: Record<string, unknown>[] = []
		const original = vi.fn<CheckCompaction>(async (message) => {
			captured.push(message)
			return true
		})
		const cls = createPatchedClass(original)

		const branch = [
			{ type: "message", message: { role: "user" } },
			{
				type: "custom",
				customType: "kimchi_error_classification",
				data: { rawMessage: RAW_OVERFLOW, reason: "context_window_exceeded", retryable: false },
			},
			{ type: "message", message: { role: "assistant", errorMessage: SANITIZED_OVERFLOW } },
		]
		const session = { sessionManager: { getBranch: () => branch } }
		const msg = { role: "assistant", stopReason: "error", errorMessage: SANITIZED_OVERFLOW }

		await patchedCheckCompaction(cls).call(session as never, msg)

		expect(captured[0].errorMessage).toBe(RAW_OVERFLOW)
	})

	it("prefers the in-process preserved raw over the audit entry", async () => {
		const captured: Record<string, unknown>[] = []
		const original = vi.fn<CheckCompaction>(async (message) => {
			captured.push(message)
			return true
		})
		const cls = createPatchedClass(original)

		const branch = [
			{
				type: "custom",
				customType: "kimchi_error_classification",
				data: { rawMessage: "earlier raw error", reason: "context_window_exceeded" },
			},
		]
		const session = { sessionManager: { getBranch: () => branch } }

		// Faithful production flow: raw present → preserve → sanitize in place.
		const faithful: Record<string, unknown> = {
			role: "assistant",
			stopReason: "error",
			errorMessage: RAW_OVERFLOW,
		}
		preserveRawErrorMessage(faithful)
		faithful.errorMessage = SANITIZED_OVERFLOW

		await patchedCheckCompaction(cls).call(session as never, faithful)

		expect(getRawErrorMessage(faithful)).toBe(RAW_OVERFLOW)
		expect(captured[0].errorMessage).toBe(RAW_OVERFLOW)
	})

	it("prefers the preserved raw over a stale audit entry even when raw === display text", async () => {
		const captured: Record<string, unknown>[] = []
		const original = vi.fn<CheckCompaction>(async (message) => {
			captured.push(message)
			return true
		})
		const cls = createPatchedClass(original)

		// A stale audit entry from an EARLIER error is on the branch. It belongs
		// to a different message and must never be substituted here.
		const staleOverflow =
			'{"error":{"type":"invalid_request_error","message":"The input (999999 tokens) is longer than the model\'s context length (262144 tokens).","retryable":false,"code":"400"}}'
		const branch = [
			{
				type: "custom",
				customType: "kimchi_error_classification",
				data: { rawMessage: staleOverflow, reason: "context_window_exceeded", retryable: false },
			},
		]
		const session = { sessionManager: { getBranch: () => branch } }

		// Raw was preserved, then sanitization turned out to be a no-op, so
		// display text === preserved raw. The in-process raw must win.
		const nonOverflow = "429 Too Many Requests"
		const msg: Record<string, unknown> = {
			role: "assistant",
			stopReason: "error",
			errorMessage: nonOverflow,
		}
		preserveRawErrorMessage(msg)

		await patchedCheckCompaction(cls).call(session as never, msg)

		// Identity pass-through: NOT a copy carrying the stale overflow raw.
		expect(captured).toHaveLength(1)
		expect(captured[0]).toBe(msg)
		expect(captured[0].errorMessage).toBe(nonOverflow)
	})

	it("passes the raw, sanitized message through unchanged when no raw is recoverable anywhere", async () => {
		const original = vi.fn<CheckCompaction>(async () => false)
		const cls = createPatchedClass(original)
		const session = { sessionManager: { getBranch: () => [] } }
		const msg = { role: "assistant", stopReason: "error", errorMessage: SANITIZED_OVERFLOW }

		await patchedCheckCompaction(cls).call(session as never, msg)

		expect(original.mock.calls[0][0]).toBe(msg)
	})
})
