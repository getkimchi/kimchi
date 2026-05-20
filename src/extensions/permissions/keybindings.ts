import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

// Unbind pi-mono's `app.thinking.cycle` so shift+tab is free for the
// permissions extension to register. Must run before main() loads the
// keybindings file. Idempotent.
export function readMultiModelShortcutFromKeybindings(agentDir: string): string | undefined {
	const keybindingsPath = resolve(agentDir, "keybindings.json")
	try {
		if (!existsSync(keybindingsPath)) return undefined
		const parsed = JSON.parse(readFileSync(keybindingsPath, "utf-8"))
		const val = parsed?.["app.multiModel.toggle"]
		if (typeof val === "string" && val.length > 0) return val
	} catch {
		// missing or malformed
	}
	return undefined
}

export function reserveShiftTabForPermissions(agentDir: string): void {
	const keybindingsPath = resolve(agentDir, "keybindings.json")
	try {
		let current: Record<string, unknown> = {}
		if (existsSync(keybindingsPath)) {
			try {
				const parsed = JSON.parse(readFileSync(keybindingsPath, "utf-8"))
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					current = parsed as Record<string, unknown>
				}
			} catch {
				// malformed; overwrite with a known-good default
			}
		}
		if (current["app.thinking.cycle"] === "") return

		current["app.thinking.cycle"] = ""
		mkdirSync(dirname(keybindingsPath), { recursive: true })
		writeFileSync(keybindingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf-8")
	} catch {
		// best-effort; a failure here just means shift+tab stays bound to thinking
	}
}
