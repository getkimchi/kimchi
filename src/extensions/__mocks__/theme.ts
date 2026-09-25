import { Theme } from "@earendil-works/pi-coding-agent"
import palette from "../../../themes/kimchi.json" with { type: "json" }

// Use real ANSI styling so width and terminal-control checks exercise coloured output.
const colors = {
	...palette.colors,
	...Object.fromEntries(
		Object.entries(palette.colors).map(([key, value]) => [key, Reflect.get(palette.vars, value) ?? value]),
	),
}
export const testTheme = new Theme(colors, colors, "truecolor")
