import { InteractiveMode } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import "./paste-to-editor-patch.js"

describe("pasteToEditor patch", () => {
	it("routes pasteToEditor through ui.handleInput instead of editor.handleInput", () => {
		const fakeIm = {
			ui: {
				handleInput: vi.fn(),
			},
			editor: {
				handleInput: vi.fn(),
			},
		}

		// biome-ignore lint/suspicious/noExplicitAny: patched upstream method not in public types
		const ctx = (InteractiveMode.prototype as any).createExtensionUIContext.call(fakeIm)
		ctx.pasteToEditor("hello")

		expect(fakeIm.ui.handleInput).toHaveBeenCalledOnce()
		expect(fakeIm.ui.handleInput).toHaveBeenCalledWith("\x1b[200~hello\x1b[201~")
		expect(fakeIm.editor.handleInput).not.toHaveBeenCalled()
	})
})
