// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { EditorComponent } from "@earendil-works/pi-tui"

// Empty editor used while the session-mode picker is mounted. Returning [] from
// render() reclaims the rows the real editor would occupy, so the picker is the
// only visible UI element. Cleanup restores the previously installed factory
// via the value captured from getEditorComponent() — never undefined — so
// upstream wiring (PromptEditor, expand handler, hardware cursor) survives.
export class NoOpPickerEditor implements EditorComponent {
	getText(): string {
		return ""
	}

	setText(_text: string): void {}

	handleInput(_data: string): void {}

	render(_width: number): string[] {
		return []
	}

	invalidate(): void {}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
