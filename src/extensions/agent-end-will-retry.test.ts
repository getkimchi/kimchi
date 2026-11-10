import { describe, expect, it, vi } from "vitest"
import { installAgentEndWillRetryPatch } from "./agent-end-will-retry.js"

/** The retry-decision inputs the wrapper reads off the session. */
type SessionState = {
	_agentRunAbortRequested?: boolean
	settingsManager?: { getRetrySettings?: () => { enabled: boolean; maxRetries: number } }
	_retryAttempt?: number
	_lastAssistantMessage?: { role: string; stopReason?: string } | undefined
	_isRetryableError?: (message: unknown) => boolean
}

function createSessionClass(state: SessionState = {}) {
	const emitted: unknown[] = []
	const proto = {
		_emitExtensionEvent: vi.fn(async (event: unknown) => {
			emitted.push(event)
		}),
	}
	const session = {
		_agentRunAbortRequested: false,
		settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 2 }) },
		_retryAttempt: 0,
		_lastAssistantMessage: undefined as { role: string; stopReason?: string } | undefined,
		_isRetryableError: () => false,
		// The extension-runner pi's _emitExtensionEvent dispatches agent_end
		// through; the wrapper's reconstructed agent_end lands here.
		_extensionRunner: {
			emit: vi.fn(async (event: unknown) => {
				emitted.push(event)
			}),
		},
		...state,
	}
	return { prototype: proto, session, emitted }
}

function emptyAgentEnd() {
	return { type: "agent_end", messages: [] }
}

describe("installAgentEndWillRetryPatch", () => {
	it("adds willRetry:true to the extension agent_end event when the retry loop will fire", async () => {
		const { prototype, session, emitted } = createSessionClass({
			_lastAssistantMessage: { role: "assistant", stopReason: "error" },
			_isRetryableError: () => true,
		})
		installAgentEndWillRetryPatch({ prototype } as never)

		await prototype._emitExtensionEvent.call(session, emptyAgentEnd())

		expect(emitted).toEqual([{ ...emptyAgentEnd(), willRetry: true }])
		expect(session).toBeDefined()
	})

	it("decides from _lastAssistantMessage, NOT from event.messages copies", async () => {
		// The live message carries the preserved raw error; a copied entry in
		// event.messages would have only the "Retrying…" placeholder and
		// classify as non-retryable. The wrapper must consult the live message.
		const { prototype, session, emitted } = createSessionClass({
			_isRetryableError: vi.fn(() => true),
		})
		session._lastAssistantMessage = { role: "assistant", stopReason: "error" }
		const copiedMessages = [{ role: "assistant", stopReason: "error", errorMessage: "Retrying…" }]
		installAgentEndWillRetryPatch({ prototype } as never)

		await prototype._emitExtensionEvent.call(session, { type: "agent_end", messages: copiedMessages })

		expect(emitted).toEqual([{ type: "agent_end", messages: copiedMessages, willRetry: true }])
		expect(session._isRetryableError).toHaveBeenCalledWith(session._lastAssistantMessage)
	})

	it("propagates willRetry:false when the classifier says the last message is not retryable", async () => {
		const { prototype, session, emitted } = createSessionClass({
			_lastAssistantMessage: { role: "assistant", stopReason: "stop" },
			_isRetryableError: () => false,
		})
		installAgentEndWillRetryPatch({ prototype } as never)

		await prototype._emitExtensionEvent.call(session, emptyAgentEnd())

		expect(emitted).toEqual([{ ...emptyAgentEnd(), willRetry: false }])
	})

	it("willRetry:false when retries are disabled", async () => {
		const { prototype, session, emitted } = createSessionClass({
			settingsManager: { getRetrySettings: () => ({ enabled: false, maxRetries: 2 }) },
			_lastAssistantMessage: { role: "assistant", stopReason: "error" },
			_isRetryableError: () => true,
		})
		installAgentEndWillRetryPatch({ prototype } as never)

		await prototype._emitExtensionEvent.call(session, emptyAgentEnd())

		expect(emitted).toEqual([{ ...emptyAgentEnd(), willRetry: false }])
	})

	it("willRetry:false when the retry budget is spent", async () => {
		const { prototype, session, emitted } = createSessionClass({
			_retryAttempt: 2,
			_lastAssistantMessage: { role: "assistant", stopReason: "error" },
			_isRetryableError: () => true,
		})
		installAgentEndWillRetryPatch({ prototype } as never)

		await prototype._emitExtensionEvent.call(session, emptyAgentEnd())

		expect(emitted).toEqual([{ ...emptyAgentEnd(), willRetry: false }])
	})

	it("willRetry:false when the run was aborted", async () => {
		const { prototype, session, emitted } = createSessionClass({
			_agentRunAbortRequested: true,
			_lastAssistantMessage: { role: "assistant", stopReason: "error" },
			_isRetryableError: () => true,
		})
		installAgentEndWillRetryPatch({ prototype } as never)

		await prototype._emitExtensionEvent.call(session, emptyAgentEnd())

		expect(emitted).toEqual([{ ...emptyAgentEnd(), willRetry: false }])
	})

	it("willRetry:false when there is no last assistant message", async () => {
		const { prototype, session, emitted } = createSessionClass({})
		installAgentEndWillRetryPatch({ prototype } as never)

		await prototype._emitExtensionEvent.call(session, emptyAgentEnd())

		expect(emitted).toEqual([{ ...emptyAgentEnd(), willRetry: false }])
	})

	it("leaves non-agent_end events untouched", async () => {
		const { prototype, session, emitted } = createSessionClass({
			_lastAssistantMessage: { role: "assistant", stopReason: "error" },
			_isRetryableError: () => true,
		})
		installAgentEndWillRetryPatch({ prototype } as never)

		const event = { type: "message_end", message: { role: "user" } }
		await prototype._emitExtensionEvent.call(session, event)

		expect(emitted).toEqual([event])
	})

	it("is a no-op on a second install (idempotent)", async () => {
		const { prototype } = createSessionClass()
		installAgentEndWillRetryPatch({ prototype } as never)
		const wrapped = prototype._emitExtensionEvent

		installAgentEndWillRetryPatch({ prototype } as never)

		expect(prototype._emitExtensionEvent).toBe(wrapped)
		expect((prototype as { _kimchiAgentEndWillRetryPatch?: boolean })._kimchiAgentEndWillRetryPatch).toBe(true)
	})

	it("is a no-op when the session lacks _emitExtensionEvent (guard)", async () => {
		const proto = { _kimchiAgentEndWillRetryPatch: undefined } as {
			_emitExtensionEvent?: unknown
			_kimchiAgentEndWillRetryPatch?: boolean
		}
		installAgentEndWillRetryPatch({ prototype: proto } as never)
		expect(proto).toEqual({})
	})
})
