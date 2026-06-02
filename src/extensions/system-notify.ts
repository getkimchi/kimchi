import { execFile, execFileSync } from "node:child_process"
import { basename } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { readNotificationsEnabled, writeNotificationsEnabled } from "../config.js"
import { findProxyHelper } from "../ssh-proxy.js"

const TITLE = "Kimchi"
const COOLDOWN_MS = 2000

let lastNotifyTime = 0

let _proxyHelper: string | null | undefined
function getProxyHelper(): string | null {
	if (_proxyHelper !== undefined) return _proxyHelper
	try {
		_proxyHelper = findProxyHelper()
	} catch {
		_proxyHelper = null
	}
	return _proxyHelper
}

function isTerminalFocused(): boolean {
	const bin = getProxyHelper()
	if (!bin) return false
	try {
		execFileSync(bin, ["tcgetpgrp"], { timeout: 500 })
		return true
	} catch {
		return false
	}
}

function shouldNotify(): boolean {
	if (!readNotificationsEnabled()) return false
	if (isTerminalFocused()) return false
	const now = Date.now()
	if (now - lastNotifyTime < COOLDOWN_MS) return false
	lastNotifyTime = now
	return true
}

async function getGitBranch(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], (error, stdout) => {
			if (error) {
				resolve(undefined)
				return
			}
			resolve(stdout.trim() || undefined)
		})
	})
}

async function buildBody(baseMessage: string): Promise<string> {
	const folder = basename(process.cwd())
	const branch = await getGitBranch()
	const context = branch ? `${folder} (${branch})` : folder
	return `${baseMessage}\n${context}`
}

function sendSystemNotification(body: string): void {
	if (process.platform === "darwin") {
		// AppleScript display notification does not support a custom icon.
		execFile(
			"osascript",
			["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(TITLE)}`],
			(err) => {
				if (err) {
					// eslint-disable-next-line no-console
					console.error("[system-notify] osascript failed:", err.message)
				}
			},
		)
	} else if (process.platform === "linux") {
		execFile("notify-send", [TITLE, body], (err) => {
			if (err) {
				// eslint-disable-next-line no-console
				console.error("[system-notify] notify-send failed:", err.message)
			}
		})
	} else if (process.platform === "win32") {
		const cmd = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, ${JSON.stringify(TITLE)}, ${JSON.stringify(body)}, [System.Windows.Forms.ToolTipIcon]::Info)`
		execFile("powershell", ["-Command", cmd], (err) => {
			if (err) {
				// eslint-disable-next-line no-console
				console.error("[system-notify] powershell failed:", err.message)
			}
		})
	}
}

export default function systemNotifyExtension(pi: ExtensionAPI): void {
	pi.registerCommand("notify", {
		description: "Toggle system notifications for agent events (on|off)",
		handler: async (args, ctx) => {
			const arg = args[0]?.toLowerCase()
			let enabled: boolean
			if (arg === "on" || arg === "true" || arg === "yes" || arg === "1" || arg === "enable" || arg === "enabled") {
				enabled = true
			} else if (
				arg === "off" ||
				arg === "false" ||
				arg === "no" ||
				arg === "0" ||
				arg === "disable" ||
				arg === "disabled"
			) {
				enabled = false
			} else {
				enabled = !readNotificationsEnabled()
			}
			writeNotificationsEnabled(enabled)
			if (ctx.hasUI) {
				ctx.ui.notify(`System notifications ${enabled ? "enabled" : "disabled"}`, "info")
			}
		},
	})

	pi.on("agent_end", async () => {
		if (shouldNotify()) {
			const body = await buildBody("Agent ended work")
			sendSystemNotification(body)
		}
	})

	pi.on("tool_execution_start", async (event) => {
		const e = event as { toolName: string }
		if (e.toolName === "questionnaire" || e.toolName === "ask_user") {
			if (!shouldNotify()) return
			const body = await buildBody("Your input is needed")
			sendSystemNotification(body)
		}
	})

	pi.on("turn_end", async () => {
		if (shouldNotify()) {
			const body = await buildBody("Agent responded")
			sendSystemNotification(body)
		}
	})
}
