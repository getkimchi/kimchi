import { execFile } from "node:child_process"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { resolveAuxiliaryFilesDir } from "../auxiliary-files/resolver.js"
import { readConfigSetting, writeConfigSetting } from "../config/settings.js"
import { HERDR_EVENTS } from "./herdr-events.js"

const execFileAsync = promisify(execFile)
const SETTING = "nativeNotifications"
const MAC_TERMINALS = new Map([
	["Apple_Terminal", "com.apple.Terminal"],
	["iTerm.app", "com.googlecode.iterm2"],
	["WarpTerminal", "dev.warp.Warp-Stable"],
	["ghostty", "com.mitchellh.ghostty"],
	["WezTerm", "com.github.wez.wezterm"],
	["vscode", "com.microsoft.VSCode"],
	["zed", "dev.zed.Zed"],
])

function enabled(): boolean {
	return readConfigSetting(SETTING, (value): value is boolean => typeof value === "boolean", true)
}

/** Submit to the OS; notification permissions and Do Not Disturb still control display. */
export async function sendNativeNotification(title: string, body: string): Promise<boolean> {
	let command: string
	let args: string[]
	switch (platform()) {
		case "darwin": {
			const app = process.env.__CFBundleIdentifier || MAC_TERMINALS.get(process.env.TERM_PROGRAM ?? "")
			// Do not send a banner whose click would open a helper or an unrelated app.
			if (!app) return false
			command = join(
				resolveAuxiliaryFilesDir(process.env, homedir(), process.execPath),
				"bin/kimchi-notifier.app/Contents/MacOS/kimchi-notifier",
			)
			args = ["notify", title, body, app]
			break
		}
		case "linux":
			command = "notify-send"
			args = ["--app-name=Kimchi", "--", title, body]
			break
		case "win32": {
			// PowerShell's registered app ID lets an unpackaged CLI send native toasts.
			const quote = (text: string) => `'${text.replaceAll("'", "''")}'`
			const script = [
				"$ErrorActionPreference = 'Stop'",
				"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
				"$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
				`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode(${quote(title)})) > $null`,
				`$xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode(${quote(body)})) > $null`,
				"$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
				"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.WindowsPowerShell').Show($toast)",
			].join("; ")
			command = "powershell.exe"
			args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
			break
		}
		default:
			return false
	}
	try {
		// macOS may need the user to answer its first notification permission prompt.
		await execFileAsync(command, args, { timeout: platform() === "darwin" ? 60_000 : 5000, windowsHide: true })
		return true
	} catch {
		// Desktop services may be absent (for example on SSH hosts). Never interrupt work.
		return false
	}
}

export default function notificationsExtension(pi: ExtensionAPI): void {
	let currentCtx: ExtensionContext | undefined
	let cancelled = false
	let blockedCount = 0
	const title = () => {
		const name = pi.getSessionName()?.trim()
		return name ? `Kimchi — ${name}` : "Kimchi"
	}
	const notify = (ctx: ExtensionContext, body: string) => {
		if (ctx.mode === "tui" && enabled()) void sendNativeNotification(title(), body)
	}
	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx
		blockedCount = 0
		cancelled = false
	})
	pi.on("agent_start", (_event, ctx) => {
		currentCtx = ctx
		cancelled = false
	})
	pi.on("agent_end", (event) => {
		cancelled = event.messages.findLast((message) => message.role === "assistant")?.stopReason === "aborted"
	})
	// agent_end can precede automatic retries and compaction. Only notify once idle.
	pi.on("agent_settled", (_event, ctx) => {
		if (!cancelled && blockedCount === 0 && ctx.isIdle() && !ctx.hasPendingMessages()) notify(ctx, "Ready for input")
	})
	// Kimchi marks agent-requested prompts explicitly. Plan review can outlive the run,
	// so ctx.isIdle() alone cannot distinguish it from a user-opened command menu.
	const unsubscribe = pi.events.on(HERDR_EVENTS.BLOCKED, (event) => {
		if (typeof event !== "object" || event === null || !("active" in event)) return
		if (event.active === true) {
			blockedCount++
			if (blockedCount === 1 && currentCtx) notify(currentCtx, "Your input is needed")
		} else if (event.active === false) {
			blockedCount = Math.max(0, blockedCount - 1)
		}
	})
	pi.on("session_shutdown", () => {
		currentCtx = undefined
		unsubscribe()
	})
	pi.registerCommand("notifications", {
		description: "Native desktop notifications: on, off, or test",
		getArgumentCompletions: (prefix) =>
			["on", "off", "test"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return
			const action = args.trim()
			if (action === "on" || action === "off") {
				writeConfigSetting(SETTING, action === "on")
				ctx.ui.notify(`Native notifications ${action}.`, "info")
			} else if (action === "test") {
				const sent = await sendNativeNotification(title(), "Native notifications are working")
				ctx.ui.notify(
					sent
						? "Notification sent to the system. If no banner appears, check your OS notification settings."
						: "Could not send a native notification. Check OS permissions and that your terminal app is supported.",
					sent ? "info" : "warning",
				)
			} else {
				ctx.ui.notify(`Native notifications ${enabled() ? "on" : "off"}. Usage: /notifications on|off|test`, "info")
			}
		},
	})
}
