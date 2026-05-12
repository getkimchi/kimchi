/**
 * Active Tools Widget
 *
 * Shows currently active/injected tools as colored pills above the editor.
 * Filters to non-builtin tools (names containing "_").
 *
 * Usage: kimchi -e extensions/active-tools.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Box, Text } from "@earendil-works/pi-tui"

const palette = [
	[12, 40, 80], // deep navy
	[50, 20, 70], // dark purple
	[10, 55, 45], // dark teal
	[70, 30, 10], // dark rust
	[55, 15, 40], // dark plum
	[15, 50, 65], // dark ocean
	[45, 45, 15], // dark olive
	[65, 18, 25], // dark wine
]

function bg(rgb: number[], s: string): string {
	return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[49m`
}

export default function (pi: ExtensionAPI) {
	const toolColors: Record<string, number[]> = {}
	let colorIdx = 0

	pi.on("tool_execution_end", async (event) => {
		if (!(event.toolName in toolColors)) {
			toolColors[event.toolName] = palette[colorIdx % palette.length]
			colorIdx++
		}
	})

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return

		let tuiRef: { requestRender(): void } | null = null

		pi.on("tool_execution_end", async () => {
			tuiRef?.requestRender()
		})

		ctx.ui.setWidget("active-tools", (tui, theme) => {
			tuiRef = tui
			const text = new Text("", 1, 1)
			return {
				render(width: number): string[] {
					const tools = pi.getActiveTools().filter((n) => n.includes("_"))
					if (tools.length === 0) {
						text.setText("")
						return text.render(width)
					}
					const parts = tools.map((name) => {
						const rgb = toolColors[name] ?? palette[0]
						return bg(rgb, `\x1b[38;2;220;220;220m  ${name}  \x1b[39m`)
					})
					text.setText(`${theme.fg("accent", `Active (${tools.length}):`)} ${parts.join(" ")}`)
					return text.render(width)
				},
				invalidate() {
					text.invalidate()
				},
				dispose() {
					tuiRef = null
				},
			}
		})
	})
}
