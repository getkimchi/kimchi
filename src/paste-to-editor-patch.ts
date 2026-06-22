/**
 * Patches the upstream pi SDK's `createExtensionUIContext` so that
 * `pasteToEditor` routes through `ui.handleInput` instead of `editor.handleInput`.
 *
 * This ensures pasted text goes through the UI's input handling layer,
 * which properly processes bracketed-paste sequences.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent"

// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype mutation
const imProto = InteractiveMode.prototype as any

const originalCreateExtensionUIContext = imProto.createExtensionUIContext

export function applyPasteToEditorPatch(): void {
	imProto.createExtensionUIContext = function patchedCreateExtensionUIContext() {
		const ctx = originalCreateExtensionUIContext.call(this)
		ctx.pasteToEditor = (text: string) => {
			this.ui.handleInput(`\x1b[200~${text}\x1b[201~`)
		}
		return ctx
	}
}

// Apply patch on module load
applyPasteToEditorPatch()
