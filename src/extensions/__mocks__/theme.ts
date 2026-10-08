import { Theme } from "@earendil-works/pi-coding-agent"
import palette from "../../../themes/kimchi.json" with { type: "json" }
import lightPalette from "../../../themes/kimchi-light.json" with { type: "json" }

// Use real ANSI styling so width and terminal-control checks exercise coloured output.
function paletteTheme({ colors, vars }: { colors: typeof palette.colors; vars: object }): Theme {
	const resolved = {
		...colors,
		...Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, Reflect.get(vars, value) ?? value])),
	}
	return new Theme(resolved, resolved, "truecolor")
}
export const testTheme = paletteTheme(palette)
export const lightTestTheme = paletteTheme(lightPalette)
