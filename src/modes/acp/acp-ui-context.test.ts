import type {
	AgentSideConnection,
	ClientCapabilities,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAcpUIContext } from "./acp-ui-context.js"
import { ADVERTISED_CAPABILITIES, CAPABILITIES_KEY } from "./capabilities.js"

type ExtMethod = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
type ExtNotification = (method: string, params: Record<string, unknown>) => Promise<void>
type CreateElicitation = (params: unknown) => Promise<{
	action: "accept" | "decline" | "cancel"
	content?: Record<string, unknown>
}>
type RequestPermissionFn = (params: unknown) => Promise<RequestPermissionResponse>
type Send = (params: SessionNotification) => void

interface MakeConnOverrides {
	extMethod?: ExtMethod
	extNotification?: ExtNotification
	unstable_createElicitation?: CreateElicitation
	requestPermission?: RequestPermissionFn
}

function makeConn(overrides: MakeConnOverrides = {}, clientCapabilities?: ClientCapabilities) {
	const extMethod = vi.fn(overrides.extMethod ?? (async () => ({})))
	const extNotification = vi.fn(overrides.extNotification ?? (async () => {}))
	const unstable_createElicitation = vi.fn(overrides.unstable_createElicitation)
	const requestPermission = vi.fn(overrides.requestPermission)
	const send = vi.fn<Send>(() => {})
	const conn = {
		extMethod,
		extNotification,
		unstable_createElicitation,
		requestPermission,
	} as unknown as AgentSideConnection
	return {
		conn,
		extMethod,
		extNotification,
		unstable_createElicitation,
		requestPermission,
		send,
		clientCapabilities,
	}
}

function uiMethodsClientCapabilities(): ClientCapabilities {
	return {
		_meta: { [CAPABILITIES_KEY]: { ...ADVERTISED_CAPABILITIES } },
	} as unknown as ClientCapabilities
}

function elicitationClientCapabilities(): ClientCapabilities {
	return { elicitation: { form: {} } } as unknown as ClientCapabilities
}

function fullClientCapabilities(): ClientCapabilities {
	return {
		_meta: { [CAPABILITIES_KEY]: { ...ADVERTISED_CAPABILITIES } },
		elicitation: { form: {} },
	} as unknown as ClientCapabilities
}

describe("createAcpUIContext — confirm via elicitation", () => {
	let elicit: ReturnType<typeof vi.fn>

	beforeEach(() => {
		elicit = vi.fn()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("calls unstable_createElicitation with a boolean form schema when client supports form elicitation", async () => {
		elicit.mockResolvedValueOnce({
			action: "accept",
			content: { confirmed: true },
		})
		const { conn, unstable_createElicitation, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.confirm("Title", "Body?")).resolves.toBe(true)

		expect(unstable_createElicitation).toHaveBeenCalledTimes(1)
		const params = unstable_createElicitation.mock.calls[0][0] as Record<string, unknown>
		expect(params).toEqual({
			message: "Title: Body?",
			mode: "form",
			requestId: expect.any(String),
			sessionId: "sess-1",
			requestedSchema: {
				type: "object",
				properties: {
					confirmed: {
						default: false,
						type: "boolean",
					},
				},
				required: ["confirmed"],
			},
		})
	})

	it("collapses to just the title when message is empty/undefined", async () => {
		elicit.mockResolvedValueOnce({
			action: "accept",
			content: { confirmed: true },
		})
		const { conn, unstable_createElicitation, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.confirm("Title-only", "")).resolves.toBe(true)
		const params = unstable_createElicitation.mock.calls[0][0] as Record<string, unknown>
		expect(params.message).toBe("Title-only")
	})

	it("resolves false when the user accepts with confirmed: false (unchecked)", async () => {
		elicit.mockResolvedValueOnce({
			action: "accept",
			content: { confirmed: false },
		})
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
	})

	it("resolves false on action: decline (user explicitly said no)", async () => {
		elicit.mockResolvedValueOnce({ action: "decline" })
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
	})

	it("resolves false on action: cancel (user dismissed without choosing)", async () => {
		elicit.mockResolvedValueOnce({ action: "cancel" })
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
	})

	it("resolves false when elicitForm rejects (transport error)", async () => {
		elicit.mockRejectedValueOnce(new Error("Method not found"))
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
	})

	it("resolves false when the signal aborts before the response arrives", async () => {
		let rejectElicit!: (err: unknown) => void
		elicit.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectElicit = reject
				}),
		)
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		const controller = new AbortController()
		const pending = real.confirm("T", "M", { signal: controller.signal })
		controller.abort()
		rejectElicit(new Error("aborted"))
		await expect(pending).resolves.toBe(false)
	})
})

describe("createAcpUIContext — confirm via request_permission fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("uses request_permission with yes/no options when client lacks elicitation.form", async () => {
		const requestPermission = vi.fn(async (_params: unknown) => ({
			outcome: { outcome: "selected", optionId: "yes" },
		}))
		const { conn, unstable_createElicitation, send } = makeConn({
			requestPermission: requestPermission as unknown as RequestPermissionFn,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.confirm("Title", "Body?")).resolves.toBe(true)

		expect(unstable_createElicitation).not.toHaveBeenCalled()
		expect(requestPermission).toHaveBeenCalledTimes(1)
		const params = requestPermission.mock.calls[0][0]
		expect(params).toEqual({
			sessionId: "sess-1",
			toolCall: {
				kind: "other",
				rawInput: {
					message: "Body?",
				},
				status: "pending",
				title: "Title",
				toolCallId: expect.any(String),
			},
			options: [
				{
					kind: "allow_once",
					name: "Yes",
					optionId: "yes",
				},
				{
					kind: "reject_once",
					name: "No",
					optionId: "no",
				},
			],
		})
	})

	it("resolves false when the user picks No", async () => {
		const requestPermission = vi.fn(async (_params: unknown) => ({
			outcome: { outcome: "selected", optionId: "no" },
		}))
		const { conn, send } = makeConn({
			requestPermission: requestPermission as unknown as RequestPermissionFn,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
	})

	it("resolves false when the outcome is cancelled", async () => {
		const requestPermission = vi.fn(async (_params: unknown) => ({
			outcome: { outcome: "cancelled" },
		}))
		const { conn, send } = makeConn({
			requestPermission: requestPermission as unknown as RequestPermissionFn,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
	})

	it("resolves false when request_permission rejects (transport error)", async () => {
		const requestPermission = vi.fn(async (_params: unknown) => {
			throw new Error("client offline")
		})
		const { conn, send } = makeConn({
			requestPermission: requestPermission as unknown as RequestPermissionFn,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
	})

	it("resolves false when requestPermission rejects (transport error)", async () => {
		const requestPermission = vi.fn(async (_params: unknown) => {
			throw new Error("client doesn't implement requestPermission")
		})
		const { conn, unstable_createElicitation, send } = makeConn({
			requestPermission: requestPermission as unknown as RequestPermissionFn,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
		expect(unstable_createElicitation).not.toHaveBeenCalled()
		expect(requestPermission).toHaveBeenCalledTimes(1)
	})
})

describe("createAcpUIContext — select via elicitation", () => {
	let elicit: ReturnType<typeof vi.fn>

	beforeEach(() => {
		elicit = vi.fn()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("calls unstable_createElicitation with a oneOf enum schema", async () => {
		elicit.mockResolvedValueOnce({ action: "accept", content: { value: "b" } })
		const { conn, unstable_createElicitation, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.select("Pick", ["a", "b", "c"])).resolves.toBe("b")
		const params = unstable_createElicitation.mock.calls[0][0]
		expect(params).toEqual({
			message: "Pick",
			mode: "form",
			requestId: expect.any(String),
			sessionId: "sess-1",
			requestedSchema: {
				properties: {
					value: {
						oneOf: [
							{
								const: "a",
								title: "a",
							},
							{
								const: "b",
								title: "b",
							},
							{
								const: "c",
								title: "c",
							},
						],
						type: "string",
					},
				},
				required: ["value"],
				type: "object",
			},
		})
	})

	it("resolves undefined when the user declines", async () => {
		elicit.mockResolvedValueOnce({ action: "decline" })
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.select("Pick", ["a", "b"])).resolves.toBeUndefined()
	})

	it("resolves undefined when the user cancels", async () => {
		elicit.mockResolvedValueOnce({ action: "cancel" })
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.select("Pick", ["a", "b"])).resolves.toBeUndefined()
	})

	it("resolves undefined when the value type is unexpected", async () => {
		elicit.mockResolvedValueOnce({ action: "accept", content: { value: 42 } })
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.select("Pick", ["a", "b"])).resolves.toBeUndefined()
	})

	it("resolves undefined with an empty options array (no call to elicit)", async () => {
		const { conn, unstable_createElicitation, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.select("Pick", [])).resolves.toBeUndefined()
		expect(unstable_createElicitation).not.toHaveBeenCalled()
	})
})

describe("createAcpUIContext — select via request_permission fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("uses request_permission with one option per choice", async () => {
		const requestPermission = vi.fn(async (_params: unknown) => ({
			outcome: { outcome: "selected", optionId: "choice-1" },
		}))
		const { conn, send } = makeConn({
			requestPermission: requestPermission as unknown as RequestPermissionFn,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.select("Pick", ["a", "b", "c"])).resolves.toBe("b")
		const params = requestPermission.mock.calls[0][0]
		expect(params).toEqual({
			sessionId: "sess-1",
			toolCall: {
				kind: "other",
				rawInput: undefined,
				status: "pending",
				title: "Pick",
				toolCallId: expect.any(String),
			},
			options: [
				{
					kind: "allow_once",
					name: "a",
					optionId: "choice-0",
				},
				{
					kind: "allow_once",
					name: "b",
					optionId: "choice-1",
				},
				{
					kind: "allow_once",
					name: "c",
					optionId: "choice-2",
				},
			],
		})
	})

	it("resolves undefined when the outcome is cancelled", async () => {
		const requestPermission = vi.fn(async (_params: unknown) => ({
			outcome: { outcome: "cancelled" },
		}))
		const { conn, send } = makeConn({
			requestPermission: requestPermission as unknown as RequestPermissionFn,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.select("Pick", ["a"])).resolves.toBeUndefined()
	})

	it("resolves undefined when optionId is malformed (defensive)", async () => {
		const requestPermission = vi.fn(async (_params: unknown) => ({
			outcome: { outcome: "selected", optionId: "choice-garbage" },
		}))
		const { conn, send } = makeConn({
			requestPermission: requestPermission as unknown as RequestPermissionFn,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.select("Pick", ["a", "b"])).resolves.toBeUndefined()
	})
})

describe("createAcpUIContext — input via elicitation", () => {
	let elicit: ReturnType<typeof vi.fn>

	beforeEach(() => {
		elicit = vi.fn()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("calls unstable_createElicitation with a string schema", async () => {
		elicit.mockResolvedValueOnce({
			action: "accept",
			content: { value: "alice" },
		})
		const { conn, unstable_createElicitation, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.input("Name", "Enter your name")).resolves.toBe("alice")
		const params = unstable_createElicitation.mock.calls[0][0]
		expect(params).toEqual({
			message: "Name",
			mode: "form",
			requestId: expect.any(String),
			sessionId: "sess-1",
			requestedSchema: {
				properties: {
					value: {
						description: "Enter your name",
						type: "string",
					},
				},
				required: ["value"],
				type: "object",
			},
		})
	})

	it("resolves undefined on decline", async () => {
		elicit.mockResolvedValueOnce({ action: "decline" })
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.input("Name", "ph")).resolves.toBeUndefined()
	})

	it("resolves undefined on cancel", async () => {
		elicit.mockResolvedValueOnce({ action: "cancel" })
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.input("Name", "ph")).resolves.toBeUndefined()
	})

	it("resolves undefined when the value type is unexpected", async () => {
		elicit.mockResolvedValueOnce({ action: "accept", content: { value: 123 } })
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		await expect(real.input("Name", "ph")).resolves.toBeUndefined()
	})

	it("falls back to notify + undefined when client lacks form elicitation (no permission equivalent for free text)", async () => {
		const { conn, extNotification, unstable_createElicitation, send } = makeConn({
			extNotification: vi.fn(async () => {}),
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.input("Workspace name", "type a name")).resolves.toBeUndefined()
		expect(unstable_createElicitation).not.toHaveBeenCalled()
		expect(extNotification).toHaveBeenCalledTimes(1)
		const [method, params] = extNotification.mock.calls[0]
		expect(method).toBe("_kimchi.dev/pi_notify")
		expect(params).toEqual({
			id: expect.any(String),
			type: "extension_ui_request",
			method: "notify",
			sessionId: "sess-1",
			message: 'Input requested: "Workspace name" (not supported by this client)',
			notifyType: "warning",
		})
	})

	it("emits an agent_message_chunk warning when the client supports neither elicitation nor notifications", async () => {
		const { conn, unstable_createElicitation, send } = makeConn()
		const real = createAcpUIContext(conn, "sess-1", undefined, send)
		await expect(real.input("Workspace name", "type a name")).resolves.toBeUndefined()
		expect(unstable_createElicitation).not.toHaveBeenCalled()
		expect(send).toHaveBeenCalledTimes(1)
		const params = send.mock.calls[0][0]
		expect(params).toEqual({
			sessionId: "sess-1",
			update: {
				content: {
					text: '[ACP] input: Extension requested free-text input "Workspace name" but the client supports neither form elicitation nor notifications. The call was dropped.',
					type: "text",
				},
				sessionUpdate: "agent_message_chunk",
			},
		})
	})
})

describe("createAcpUIContext — capability gating", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("prefers elicitation when both elicitation and _kimchi.dev/pi are advertised", async () => {
		const elicit = vi.fn(async () => ({
			action: "accept",
			content: { confirmed: true },
		}))
		const extMethod = vi.fn(async () => ({ confirmed: true }))
		const {
			conn,
			unstable_createElicitation,
			extMethod: em,
			send,
		} = makeConn({
			extMethod: extMethod as unknown as ExtMethod,
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(true)
		expect(unstable_createElicitation).toHaveBeenCalledTimes(1)
		expect(em).not.toHaveBeenCalled()
	})

	it("treats an empty elicitation.form object as supporting form elicitation", async () => {
		const elicit = vi.fn(async () => ({
			action: "accept",
			content: { value: "x" },
		}))
		const { conn, send } = makeConn({
			unstable_createElicitation: elicit as unknown as CreateElicitation,
		})
		const caps = { elicitation: { form: {} } } as unknown as ClientCapabilities
		const real = createAcpUIContext(conn, "sess-1", caps, send)
		await expect(real.select("Pick", ["x", "y"])).resolves.toBe("x")
		expect(elicit).toHaveBeenCalledTimes(1)
	})

	it("treats elicitation.form undefined as not supporting form elicitation (falls back to request_permission)", async () => {
		const requestPermission = vi.fn(async (_params: unknown) => ({
			outcome: { outcome: "selected", optionId: "yes" },
		}))
		const { conn, send } = makeConn({
			requestPermission: requestPermission as unknown as RequestPermissionFn,
		})
		// url-only capability: form is null, so we should fall back.
		const caps = { elicitation: { url: {} } } as unknown as ClientCapabilities
		const real = createAcpUIContext(conn, "sess-1", caps, send)
		await expect(real.confirm("T", "M")).resolves.toBe(true)
		expect(requestPermission).toHaveBeenCalledTimes(1)
	})
})

describe("createAcpUIContext — editor (still on _kimchi.dev/pi namespace)", () => {
	let extMethod: ReturnType<typeof vi.fn>

	beforeEach(() => {
		extMethod = vi.fn()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("calls _kimchi.dev/pi_editor and returns the edited text", async () => {
		extMethod.mockResolvedValueOnce({ value: "draft" })
		const { conn, send } = makeConn({
			extMethod: extMethod as unknown as ExtMethod,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		await expect(real.editor("Edit", "starting point")).resolves.toBe("draft")
		const [method, params] = extMethod.mock.calls[0]
		expect(method).toBe("_kimchi.dev/pi_editor")
		expect(params).toEqual({
			id: expect.any(String),
			type: "extension_ui_request",
			method: "editor",
			sessionId: "sess-1",
			title: "Edit",
			prefill: "starting point",
		})
	})

	it("resolves undefined on cancellation", async () => {
		extMethod.mockResolvedValueOnce({ cancelled: true })
		const { conn, send } = makeConn({
			extMethod: extMethod as unknown as ExtMethod,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		await expect(real.editor("Edit", "starting")).resolves.toBeUndefined()
	})

	it("resolves undefined and warns via agent_message_chunk when the client doesn't advertise the pi capability", async () => {
		const { conn, extMethod: m, send } = makeConn()
		const real = createAcpUIContext(conn, "sess-1", elicitationClientCapabilities(), send)
		// editor can't fall back to elicitation (no textarea in restricted JSON Schema).
		await expect(real.editor("Edit", "starting")).resolves.toBeUndefined()
		expect(m).not.toHaveBeenCalled()
		expect(send).toHaveBeenCalledTimes(1)
		const params = send.mock.calls[0][0]
		expect(params).toEqual({
			sessionId: "sess-1",
			update: {
				content: {
					text: '[ACP] editor: Extension requested an editor ("Edit") but the client doesn\'t advertise the _kimchi.dev/pi_editor capability. The request was dropped.',
					type: "text",
				},
				sessionUpdate: "agent_message_chunk",
			},
		})
	})
})

describe("createAcpUIContext — fire-and-forget notifications", () => {
	let extNotification: ReturnType<typeof vi.fn>

	beforeEach(() => {
		extNotification = vi.fn(async () => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("notify sends _kimchi.dev/pi_notify via extNotification with notifyType undefined when type is omitted", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		real.notify("hello")
		await new Promise((r) => setImmediate(r))
		expect(n).toHaveBeenCalledTimes(1)
		const [method, params] = n.mock.calls[0]
		expect(method).toBe("_kimchi.dev/pi_notify")
		expect(params).toEqual({
			id: expect.any(String),
			type: "extension_ui_request",
			method: "notify",
			sessionId: "sess-1",
			message: "hello",
			// rpc-mode leaves notifyType undefined when the type argument is omitted;
			// clients default to "info" themselves.
			notifyType: undefined,
		})
	})

	it("notify forwards the notifyType when provided", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		real.notify("careful", "warning")
		await new Promise((r) => setImmediate(r))
		expect(n.mock.calls[0][1].notifyType).toBe("warning")
	})

	it("notify swallows transport errors (no rejection visible to the caller)", async () => {
		extNotification.mockRejectedValueOnce(new Error("socket closed"))
		const { conn, send } = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		expect(() => real.notify("boom")).not.toThrow()
		await new Promise((r) => setImmediate(r))
	})

	it("showError forwards to notify with notifyType 'error'", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		real.showError("boom")
		await new Promise((r) => setImmediate(r))
		expect(n).toHaveBeenCalledTimes(1)
		const [method, params] = n.mock.calls[0]
		expect(method).toBe("_kimchi.dev/pi_notify")
		expect(params).toEqual({
			id: expect.any(String),
			type: "extension_ui_request",
			method: "notify",
			sessionId: "sess-1",
			message: "boom",
			notifyType: "error",
		})
	})

	it("showError swallows transport errors (no rejection visible to the caller)", async () => {
		extNotification.mockRejectedValueOnce(new Error("socket closed"))
		const { conn, send } = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		expect(() => real.showError("boom")).not.toThrow()
		await new Promise((r) => setImmediate(r))
	})

	it("setStatus sends _kimchi.dev/pi_notify via extNotification", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		real.setStatus("tokens", "1.2k")
		await new Promise((r) => setImmediate(r))
		expect(n).toHaveBeenCalledTimes(1)
		const [method, params] = n.mock.calls[0]
		expect(method).toBe("_kimchi.dev/pi_notify")
		expect(params).toEqual({
			id: expect.any(String),
			type: "extension_ui_request",
			method: "setStatus",
			sessionId: "sess-1",
			statusKey: "tokens",
			statusText: "1.2k",
		})
	})

	it("setStatus forwards undefined text (clear)", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		real.setStatus("tokens", undefined)
		await new Promise((r) => setImmediate(r))
		expect(n.mock.calls[0][1].statusText).toBeUndefined()
	})

	it("setEditorText sends _kimchi.dev/pi_notify via extNotification", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		real.setEditorText("draft message")
		await new Promise((r) => setImmediate(r))
		expect(n).toHaveBeenCalledTimes(1)
		const [method, params] = n.mock.calls[0]
		expect(method).toBe("_kimchi.dev/pi_notify")
		expect(params).toEqual({
			id: expect.any(String),
			type: "extension_ui_request",
			method: "set_editor_text",
			sessionId: "sess-1",
			text: "draft message",
		})
	})

	it("pasteToEditor delegates to setEditorText (rpc-mode parity)", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		real.pasteToEditor("pasted")
		await new Promise((r) => setImmediate(r))
		expect(n.mock.calls[0][1].method).toBe("set_editor_text")
		expect(n.mock.calls[0][1].text).toBe("pasted")
	})

	it("setWidget (string[] branch) forwards to _kimchi.dev/pi_notify", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		real.setWidget("todo", ["line 1", "line 2"], { placement: "belowEditor" })
		await new Promise((r) => setImmediate(r))
		expect(n).toHaveBeenCalledTimes(1)
		const [method, params] = n.mock.calls[0]
		expect(method).toBe("_kimchi.dev/pi_notify")
		expect(params).toEqual({
			id: expect.any(String),
			type: "extension_ui_request",
			method: "setWidget",
			sessionId: "sess-1",
			widgetKey: "todo",
			widgetLines: ["line 1", "line 2"],
			widgetPlacement: "belowEditor",
		})
	})

	it("setWidget (string[] undefined) forwards as clear", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		real.setWidget("todo", undefined)
		await new Promise((r) => setImmediate(r))
		expect(n.mock.calls[0][1].widgetLines).toBeUndefined()
	})

	it("setWidget (component-factory branch) is silently dropped (no ACP equivalent)", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		// Cast to bypass the noop assertion — we're invoking the unsupported branch deliberately.
		;(real.setWidget as unknown as (k: string, c: unknown) => void)(
			"todo",
			() =>
				({
					getText: () => "",
					setText: () => {},
					dispose: () => {},
				}) as unknown as object,
		)
		await new Promise((r) => setImmediate(r))
		expect(n).not.toHaveBeenCalled()
	})

	it("setTitle emits a session_info_update via send (deliberate divergence from rpc-mode)", () => {
		const { conn, send } = makeConn()
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		real.setTitle("My session")
		expect(send).toHaveBeenCalledTimes(1)
		const params = send.mock.calls[0][0]
		expect(params).toEqual({
			sessionId: "sess-1",
			update: {
				sessionUpdate: "session_info_update",
				title: "My session",
			},
		})
	})
})

describe("createAcpUIContext — TUI-only no-op stubs", () => {
	const { conn, send } = makeConn()

	it("does not throw and has the right shape for every TUI-only method", () => {
		const real = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send)
		// TerminalInputHandler may return { consume?, data? } | undefined to
		// steer pi's input pipeline. A bare () => {} doesn't satisfy that
		// shape; the test only asserts the unsubscribe round-trip works.
		const terminalHandler: import("@earendil-works/pi-coding-agent").TerminalInputHandler = () => undefined
		const autocompleteFactory: import("@earendil-works/pi-coding-agent").AutocompleteProviderFactory = (current) =>
			current
		const customFactory: Parameters<typeof real.custom>[0] = () => {
			throw new Error("custom factory must not be invoked in ACP mode")
		}
		expect(() => real.setWorkingMessage("msg")).not.toThrow()
		expect(() => real.setWorkingMessage()).not.toThrow()
		expect(() => real.setWorkingVisible(true)).not.toThrow()
		expect(() => real.setWorkingVisible(false)).not.toThrow()
		expect(() => real.setWorkingIndicator({ frames: ["●"], intervalMs: 100 })).not.toThrow()
		expect(() => real.setHiddenThinkingLabel("label")).not.toThrow()
		expect(() => real.setFooter(undefined)).not.toThrow()
		expect(() => real.setHeader(undefined)).not.toThrow()
		expect(() => real.addAutocompleteProvider(autocompleteFactory)).not.toThrow()
		expect(() => real.setEditorComponent(undefined)).not.toThrow()
		expect(() => real.setToolsExpanded(true)).not.toThrow()
		expect(real.getEditorText()).toBe("")
		expect(real.getToolsExpanded()).toBe(false)
		expect(real.getEditorComponent()).toBeUndefined()
		expect(real.getAllThemes()).toEqual([])
		expect(real.getTheme("anything")).toBeUndefined()
		expect(real.setTheme("anything")).toEqual({
			success: false,
			error: "themes are not supported in ACP mode",
		})
		expect(real.previewTheme("anything")).toEqual({
			success: false,
			error: "themes are not supported in ACP mode",
		})
		// theme getter must exist and be readable; the value is a Proxy so we
		// only assert the accessor doesn't throw.
		expect(() => real.theme).not.toThrow()
		// Terminal-input listener returns an unsubscribe that is itself callable.
		const unsubscribe = real.onTerminalInput(terminalHandler)
		expect(typeof unsubscribe).toBe("function")
		expect(() => unsubscribe()).not.toThrow()
		// custom() resolves undefined so callers that ignore the return value don't crash.
		return expect(real.custom(customFactory)).resolves.toBeUndefined()
	})
})

describe("createAcpUIContext — noop theme preserves text", () => {
	const { conn, send } = makeConn()
	const theme = createAcpUIContext(conn, "sess-1", fullClientCapabilities(), send).theme

	it("fg passes the text through unchanged regardless of color", () => {
		expect(theme.fg("accent", "keep me")).toBe("keep me")
		expect(theme.fg("error", "keep me")).toBe("keep me")
		expect(theme.fg("mdCode" as never, "keep me")).toBe("keep me")
	})

	it("bg passes the text through unchanged regardless of color", () => {
		expect(theme.bg("selectedBg", "keep me")).toBe("keep me")
		expect(theme.bg("toolErrorBg", "keep me")).toBe("keep me")
	})

	it("bold, italic, underline, inverse, strikethrough all return the original text", () => {
		expect(theme.bold("keep me")).toBe("keep me")
		expect(theme.italic("keep me")).toBe("keep me")
		expect(theme.underline("keep me")).toBe("keep me")
		expect(theme.inverse("keep me")).toBe("keep me")
		expect(theme.strikethrough("keep me")).toBe("keep me")
	})

	it("empty string text is preserved (not coerced to undefined)", () => {
		expect(theme.fg("accent", "")).toBe("")
		expect(theme.bold("")).toBe("")
		expect(theme.bg("selectedBg", "")).toBe("")
	})

	it("text containing ANSI escapes is preserved verbatim", () => {
		const escaped = "\u001b[31mred\u001b[0m"
		expect(theme.fg("accent", escaped)).toBe(escaped)
		expect(theme.bold(escaped)).toBe(escaped)
	})

	it("text can be chained through multiple style methods without loss", () => {
		const styled = theme.bold(theme.italic(theme.fg("accent", "keep me")))
		expect(styled).toBe("keep me")
	})

	it("non-styling Theme methods still return undefined (no passthrough)", () => {
		expect(theme.getFgAnsi("accent")).toBeUndefined()
		expect(theme.getBgAnsi("selectedBg")).toBeUndefined()
		expect(theme.getColorMode()).toBeUndefined()
		expect(theme.getThinkingBorderColor("high")).toBeUndefined()
		expect(theme.getBashModeBorderColor()).toBeUndefined()
	})

	it("the theme proxy is not thenable (no accidental promise wrapping)", () => {
		expect((theme as unknown as { then?: unknown }).then).toBeUndefined()
		expect((theme as unknown as { catch?: unknown }).catch).toBeUndefined()
	})
})
