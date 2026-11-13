import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

/**
 * Surface a notification to the user wherever they are: a `ui.notify` toast
 * (TUI popup / ACP extNotification) when a UI is attached, a severity-matched
 * console level in headless (print/ACP) modes.
 *
 * For UI-only notifications — where no headless fallback is wanted — guard
 * `ctx.ui.notify` directly instead. That is a different, deliberate contract.
 */
export function notifyUser(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	message: string,
	severity: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, severity)
		return
	}
	if (severity === "error") console.error(message)
	else if (severity === "warning") console.warn(message)
	else console.log(message)
}
