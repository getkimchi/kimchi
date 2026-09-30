import type { Theme } from "@earendil-works/pi-coding-agent"

/**
 * Theme fake that wraps every styled span in a tag naming the color applied,
 * e.g. `<dim>label</dim>`. Lets renderer tests assert *which* theme color a
 * span received — the common passthrough fake (`fg: (_color, s) => s`) erases
 * exactly that information.
 *
 * The tags are plain text, so they pass through `Container.render()` and can
 * be asserted with plain `toContain`.
 */
export function taggingTheme(): Theme {
	return {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
		bold: (text: string) => `<bold>${text}</bold>`,
		getFgAnsi: (_color: string) => "",
	} as unknown as Theme
}
