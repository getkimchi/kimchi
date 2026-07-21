import { describe, expect, it } from "vitest"
import { GENERAL_TIPS } from "./general-tips.js"
import { renderTipRow } from "./tip-row.js"
import type { TipCandidate } from "./types.js"

const plainTheme = {
	fg: (_color: string, text: string) => text,
} as never

describe("GENERAL_TIPS", () => {
	it("uses concrete Kimchi workflows instead of generic placeholders", () => {
		const messages = GENERAL_TIPS.map((tip) => tip.message)

		expect(messages).toContain("Press `shift+tab` to change permissions mode.")
		expect(messages).toContain("Run `/settings > Themes` to change colors.")
		expect(messages).toContain("Use `ctrl+p` or `/model` to select multi-model for auto routing.")
		expect(messages).toContain("Use `/model` to select single model for entire session")
		expect(messages).toContain("Use `/agents` to manage agents or display running agents sessions")
		expect(messages).toContain("Tag requests in Analytics: `/tags add key:value` (e.g. project:myapp).")
		expect(messages).toContain("Resume the latest session with `kimchi --continue`.")
		expect(messages).toContain("Name a branch with `/branch <name>`; resume it with `-r <id>`.")
		expect(messages).toContain("Use `kimchi --verbose` when output looks off.")
		expect(messages).toContain("Run `/bug` to create GitHub issue with a bug report.")
	})

	it("fits every built-in tip in an 80-column row without truncation", () => {
		for (const tip of GENERAL_TIPS) {
			const [line] = renderTipRow({ ...tip, source: "kimchi.general" } as TipCandidate, plainTheme, 80)

			expect(line, tip.id).not.toContain("...")
		}
	})
})
