import type { AgentSideConnection, ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAcpUIContext } from "./acp-ui-context.js"
import { CAPABILITIES_KEY } from "./capabilities.js"

type ExtMethod = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
type ExtNotification = (method: string, params: Record<string, unknown>) => Promise<void>
type Send = (params: SessionNotification) => void

function makeConn(
	overrides: {
		extMethod?: ExtMethod
		extNotification?: ExtNotification
	} = {},
	clientCapabilities?: ClientCapabilities,
) {
	const extMethod = vi.fn(overrides.extMethod ?? (async () => ({})))
	const extNotification = vi.fn(overrides.extNotification ?? (async () => {}))
	const send = vi.fn<Send>(() => {})
	const conn = { extMethod, extNotification } as unknown as AgentSideConnection
	return {
		conn,
		extMethod,
		extNotification,
		send,
		clientCapabilities,
	}
}

function uiMethodsClientCapabilities(): ClientCapabilities {
	return { _meta: { [CAPABILITIES_KEY]: { pi: true } } } as unknown as ClientCapabilities
}

// Shared envelope-shape assertions. Every wire payload must carry the
// type/id/sessionId envelope and the matching method name so clients that
// already dispatch on pi's extension_ui_request format can reuse their
// existing handlers.
function expectExtensionUiRequestEnvelope(params: Record<string, unknown>, method: string, sessionId = "sess-1"): void {
	expect(params.type).toBe("extension_ui_request")
	expect(params.method).toBe(method)
	expect(params.sessionId).toBe(sessionId)
	expect(typeof params.id).toBe("string")
}

describe("createAcpUIContext — dialog methods", () => {
	let extMethod: ReturnType<typeof vi.fn>

	beforeEach(() => {
		extMethod = vi.fn()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("confirm calls _kimchi.dev/pi/confirm and resolves true on { value: true }", async () => {
		extMethod.mockResolvedValueOnce({ value: true })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		const controller = new AbortController()
		const result = await real.confirm("Title", "Body?", { signal: controller.signal })
		expect(result).toBe(true)
		expect(extMethod).toHaveBeenCalledTimes(1)
		expect(extMethod.mock.calls[0][0]).toBe("_kimchi.dev/pi/confirm")
		const params = extMethod.mock.calls[0][1]
		expectExtensionUiRequestEnvelope(params, "confirm")
		expect(params.title).toBe("Title")
		expect(params.message).toBe("Body?")
	})

	it("confirm resolves true when the client uses the legacy { confirmed: true } shape", async () => {
		extMethod.mockResolvedValueOnce({ confirmed: true })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(true)
	})

	it("confirm resolves false on { value: false }", async () => {
		extMethod.mockResolvedValueOnce({ value: false })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
	})

	it("confirm resolves false when the client returns { cancelled: true }", async () => {
		extMethod.mockResolvedValueOnce({ cancelled: true })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
	})

	it("confirm resolves false when the client does not advertise the pi capability", async () => {
		const { conn, extMethod: m, send } = makeConn()
		const real = createAcpUIContext(conn, "sess-1", undefined, send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
		expect(m).not.toHaveBeenCalled()
	})

	it("confirm resolves false when the client returns an unexpected shape", async () => {
		extMethod.mockResolvedValueOnce({ something: "else" })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
	})

	it("confirm resolves false when extMethod throws (client returned an error envelope)", async () => {
		extMethod.mockRejectedValueOnce(new Error("Method not found"))
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.confirm("T", "M")).resolves.toBe(false)
	})

	it("confirm resolves false when the signal aborts before the client responds", async () => {
		let rejectExtMethod!: (err: unknown) => void
		extMethod.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectExtMethod = reject
				}),
		)
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		const controller = new AbortController()
		const pending = real.confirm("T", "M", { signal: controller.signal })
		controller.abort()
		// Reject the underlying extMethod to simulate the request failing after
		// abort — confirm must still resolve false, not reject.
		rejectExtMethod(new Error("aborted"))
		await expect(pending).resolves.toBe(false)
	})

	it("confirm resolves false when called with an already-aborted signal", async () => {
		const { conn, send } = makeConn()
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		const controller = new AbortController()
		controller.abort()
		await expect(real.confirm("T", "M", { signal: controller.signal })).resolves.toBe(false)
	})

	it("confirm propagates opts.timeout to the wire payload", async () => {
		extMethod.mockResolvedValueOnce({ confirmed: true })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await real.confirm("T", "M", { timeout: 5000 })
		expect(extMethod.mock.calls[0][1].timeout).toBe(5000)
	})

	it("select calls _kimchi.dev/pi/select and returns the chosen string", async () => {
		extMethod.mockResolvedValueOnce({ value: "b" })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.select("Pick", ["a", "b", "c"])).resolves.toBe("b")
		expect(extMethod.mock.calls[0][0]).toBe("_kimchi.dev/pi/select")
		const params = extMethod.mock.calls[0][1]
		expectExtensionUiRequestEnvelope(params, "select")
		expect(params.options).toEqual(["a", "b", "c"])
	})

	it("select resolves undefined on { cancelled: true }", async () => {
		extMethod.mockResolvedValueOnce({ cancelled: true })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.select("Pick", ["a"])).resolves.toBeUndefined()
	})

	it("select resolves undefined when the value is the wrong type", async () => {
		extMethod.mockResolvedValueOnce({ value: 42 })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.select("Pick", ["a"])).resolves.toBeUndefined()
	})

	it("select resolves undefined when the client doesn't advertise support", async () => {
		const { conn, extMethod: m, send } = makeConn()
		const real = createAcpUIContext(conn, "sess-1", undefined, send)
		await expect(real.select("Pick", ["a"])).resolves.toBeUndefined()
		expect(m).not.toHaveBeenCalled()
	})

	it("input calls _kimchi.dev/pi/input and returns the typed string", async () => {
		extMethod.mockResolvedValueOnce({ value: "hello" })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.input("Name", "Enter your name")).resolves.toBe("hello")
		const params = extMethod.mock.calls[0][1]
		expect(extMethod.mock.calls[0][0]).toBe("_kimchi.dev/pi/input")
		expectExtensionUiRequestEnvelope(params, "input")
		expect(params.placeholder).toBe("Enter your name")
	})

	it("editor calls _kimchi.dev/pi/editor and returns the edited text", async () => {
		extMethod.mockResolvedValueOnce({ value: "draft" })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.editor("Edit", "starting point")).resolves.toBe("draft")
		const params = extMethod.mock.calls[0][1]
		expect(extMethod.mock.calls[0][0]).toBe("_kimchi.dev/pi/editor")
		expectExtensionUiRequestEnvelope(params, "editor")
		expect(params.prefill).toBe("starting point")
		// editor doesn't propagate timeout — matches pi's rpc-mode behaviour.
		expect(params.timeout).toBeUndefined()
	})

	it("editor resolves undefined on cancellation", async () => {
		extMethod.mockResolvedValueOnce({ cancelled: true })
		const { conn, send } = makeConn({ extMethod: extMethod as unknown as ExtMethod })
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		await expect(real.editor("Edit", "starting")).resolves.toBeUndefined()
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

	it("notify sends _kimchi.dev/pi/notify via extNotification with notifyType undefined when type is omitted", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		real.notify("hello")
		await new Promise((r) => setImmediate(r))
		expect(n).toHaveBeenCalledTimes(1)
		const [method, params] = n.mock.calls[0]
		expect(method).toBe("_kimchi.dev/pi/notify")
		expectExtensionUiRequestEnvelope(params, "notify")
		expect(params.message).toBe("hello")
		// rpc-mode leaves notifyType undefined when the type argument is
		// omitted; clients default to "info" themselves. Match exactly so
		// shared wire-format clients don't see divergent behaviour.
		expect(params.notifyType).toBeUndefined()
	})

	it("notify forwards the notifyType when provided", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		real.notify("careful", "warning")
		await new Promise((r) => setImmediate(r))
		expect(n.mock.calls[0][1].notifyType).toBe("warning")
	})

	it("notify swallows transport errors (no rejection visible to the caller)", async () => {
		extNotification.mockRejectedValueOnce(new Error("socket closed"))
		const { conn, send } = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		// notify is fire-and-forget: this must not throw.
		expect(() => real.notify("boom")).not.toThrow()
		await new Promise((r) => setImmediate(r))
	})

	it("setStatus sends _kimchi.dev/pi/setStatus via extNotification", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		real.setStatus("tokens", "1.2k")
		await new Promise((r) => setImmediate(r))
		expect(n).toHaveBeenCalledTimes(1)
		const [method, params] = n.mock.calls[0]
		expect(method).toBe("_kimchi.dev/pi/setStatus")
		expectExtensionUiRequestEnvelope(params, "setStatus")
		expect(params.statusKey).toBe("tokens")
		expect(params.statusText).toBe("1.2k")
	})

	it("setStatus forwards undefined text (clear)", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		real.setStatus("tokens", undefined)
		await new Promise((r) => setImmediate(r))
		expect(n.mock.calls[0][1].statusText).toBeUndefined()
	})

	it("setStatus is silent when the client doesn't advertise support", () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", undefined, send)
		real.setStatus("k", "v")
		expect(n).not.toHaveBeenCalled()
	})

	it("setEditorText sends _kimchi.dev/pi/set_editor_text via extNotification", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		real.setEditorText("draft message")
		await new Promise((r) => setImmediate(r))
		expect(n).toHaveBeenCalledTimes(1)
		const [method, params] = n.mock.calls[0]
		expect(method).toBe("_kimchi.dev/pi/set_editor_text")
		expectExtensionUiRequestEnvelope(params, "set_editor_text")
		expect(params.text).toBe("draft message")
	})

	it("pasteToEditor delegates to setEditorText (rpc-mode parity)", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		real.pasteToEditor("pasted")
		await new Promise((r) => setImmediate(r))
		expect(n.mock.calls[0][1].method).toBe("set_editor_text")
		expect(n.mock.calls[0][1].text).toBe("pasted")
	})

	it("setWidget (string[] branch) forwards to _kimchi.dev/pi/setWidget", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		real.setWidget("todo", ["line 1", "line 2"], { placement: "belowEditor" })
		await new Promise((r) => setImmediate(r))
		expect(n).toHaveBeenCalledTimes(1)
		const [method, params] = n.mock.calls[0]
		expect(method).toBe("_kimchi.dev/pi/setWidget")
		expectExtensionUiRequestEnvelope(params, "setWidget")
		expect(params.widgetKey).toBe("todo")
		expect(params.widgetLines).toEqual(["line 1", "line 2"])
		expect(params.widgetPlacement).toBe("belowEditor")
	})

	it("setWidget (string[] undefined) forwards as clear", async () => {
		const {
			conn,
			extNotification: n,
			send,
		} = makeConn({
			extNotification: extNotification as unknown as ExtNotification,
		})
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
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
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		// Cast to bypass the noop assertion — we're invoking the unsupported branch deliberately.
		;(real.setWidget as unknown as (k: string, c: unknown) => void)(
			"todo",
			() => ({ getText: () => "", setText: () => {}, dispose: () => {} }) as unknown as object,
		)
		await new Promise((r) => setImmediate(r))
		expect(n).not.toHaveBeenCalled()
	})

	it("setTitle emits a session_info_update via send (deliberate divergence from rpc-mode)", () => {
		const { conn, send } = makeConn()
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
		real.setTitle("My session")
		expect(send).toHaveBeenCalledTimes(1)
		const update = send.mock.calls[0][0].update
		expect(update.sessionUpdate).toBe("session_info_update")
		if (update.sessionUpdate === "session_info_update") {
			expect(update.title).toBe("My session")
		}
	})
})

describe("createAcpUIContext — TUI-only no-op stubs", () => {
	const { conn, send } = makeConn()

	it("does not throw and has the right shape for every TUI-only method", () => {
		const real = createAcpUIContext(conn, "sess-1", uiMethodsClientCapabilities(), send)
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
