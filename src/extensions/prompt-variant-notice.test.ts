import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PROMPT_VARIANT_ENV } from "./prompt-construction/variants/index.js"
import promptVariantNoticeExtension from "./prompt-variant-notice.js"

type Handler = (event: unknown, ctx: ExtensionContext) => unknown

function createPiMock() {
	const handlers: Handler[] = []
	const pi = {
		on: (event: string, handler: Handler) => {
			if (event === "session_start") handlers.push(handler)
		},
	}
	return { pi: pi as unknown as ExtensionAPI, handlers }
}

function createCtx(hasUI: boolean) {
	const setStatus = vi.fn()
	const ctx = { hasUI, ui: { setStatus } } as unknown as ExtensionContext
	return { ctx, setStatus }
}

function fireSessionStart(hasUI: boolean) {
	const { pi, handlers } = createPiMock()
	promptVariantNoticeExtension(pi)
	const { ctx, setStatus } = createCtx(hasUI)
	for (const handler of handlers) handler({}, ctx)
	return { setStatus }
}

describe("promptVariantNoticeExtension", () => {
	let savedVariant: string | undefined
	let warn: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		savedVariant = process.env[PROMPT_VARIANT_ENV]
		warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		if (savedVariant === undefined) {
			delete process.env[PROMPT_VARIANT_ENV]
		} else {
			process.env[PROMPT_VARIANT_ENV] = savedVariant
		}
		vi.restoreAllMocks()
	})

	it("says nothing for the default variant", () => {
		delete process.env[PROMPT_VARIANT_ENV]
		const { setStatus } = fireSessionStart(true)
		expect(setStatus).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})

	it("says nothing for an unknown variant name, which falls back to the default", () => {
		process.env[PROMPT_VARIANT_ENV] = "no-such-variant"
		const { setStatus } = fireSessionStart(true)
		expect(setStatus).not.toHaveBeenCalled()
		expect(warn).not.toHaveBeenCalled()
	})

	it("sets the footer status when the session has a UI", () => {
		process.env[PROMPT_VARIANT_ENV] = "spicy"
		const { setStatus } = fireSessionStart(true)
		expect(setStatus).toHaveBeenCalledWith("prompt-variant", "prompt variant: spicy architect")
		expect(warn).not.toHaveBeenCalled()
	})

	it("writes a single line to the error stream without a UI, leaving stdout clean", () => {
		process.env[PROMPT_VARIANT_ENV] = "spicy"
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const { setStatus } = fireSessionStart(false)
		expect(setStatus).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith("[kimchi] prompt variant: spicy architect")
		expect(stdoutWrite).not.toHaveBeenCalled()
	})
})
