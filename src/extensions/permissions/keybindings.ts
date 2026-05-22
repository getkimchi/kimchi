import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

// Check if a key is used as a binding value in any binding OTHER than
// "tui.input.newLine" (which is the one we are trying to fix).
function isKeyBoundElsewhere(current: Record<string, unknown>, key: string): boolean {
	for (const [bindingName, value] of Object.entries(current)) {
		if (bindingName === "tui.input.newLine") continue
		if (typeof value === "string") {
			const parts = value.split(",").map((s) => s.trim())
			if (parts.includes(key)) return true
		}
		if (Array.isArray(value)) {
			if (value.some((v) => typeof v === "string" && v.trim() === key)) return true
		}
	}
	return false
}

// Add ctrl+j as a fallback to tui.input.newLine if not already present
// and not already bound elsewhere.
//
// IMPORTANT: bindings must be stored as a JSON array, not a comma-separated
// string. pi-tui's parseKeyId splits on "+" and takes the last segment, so
// "shift+enter,ctrl+j" (string) is parsed as "shift+j" instead of two
// separate bindings.
function addNewlineFallback(current: Record<string, unknown>): boolean {
	const fallback = "ctrl+j"
	const existing = current["tui.input.newLine"]

	// Don't add if it's already used as a binding elsewhere (conflict check)
	if (isKeyBoundElsewhere(current, fallback)) return false

	if (typeof existing === "string") {
		// Comma-separated strings are misread by pi-tui ("shift+enter,ctrl+j"
		// becomes "shift+j"). Always convert to array format.
		const parts = existing.split(",").map((s) => s.trim())
		const keys = parts.includes(fallback) ? parts : [...parts, fallback]
		current["tui.input.newLine"] = keys
		return true // always rewrite: string format must become an array
	}
	if (Array.isArray(existing)) {
		const list = existing.filter((s) => typeof s === "string") as string[]
		if (!list.includes(fallback)) {
			current["tui.input.newLine"] = [...list, fallback]
			return true
		}
	} else {
		current["tui.input.newLine"] = ["shift+enter", fallback]
		return true
	}
	return false
}

export function writeKimchiKeybindingDefaults(agentDir: string): void {
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

		// Unbind shift+tab from thinking cycle
		if (current["app.thinking.cycle"] !== "") {
			current["app.thinking.cycle"] = ""
		}

		// Add ctrl+j as newline fallback if needed
		const addedNewlineFallback = addNewlineFallback(current)

		// Only write if we made changes
		if (current["app.thinking.cycle"] === "" && !addedNewlineFallback && existsSync(keybindingsPath)) {
			return
		}

		mkdirSync(dirname(keybindingsPath), { recursive: true })
		writeFileSync(keybindingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf-8")
	} catch {
		// best-effort; a failure here just means shift+tab stays bound to thinking
	}
}

// Keep old name as deprecated alias for backwards compatibility
export const reserveShiftTabForPermissions = writeKimchiKeybindingDefaults
