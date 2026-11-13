import { expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { CODEMODE_SELECTION_GUIDANCE, createGuidedCodemodeExtension } from "./guidance.js"

function codemodeDescription(): string | undefined {
	const mock = createExtensionApi()
	createGuidedCodemodeExtension()(mock.api)
	const codemode = mock.getRegisteredTool("codemode")
	expect(codemode.defaultActive).toBe(false)
	return codemode.prepareLoadout?.({
		declared: [],
		callable: [],
		registered: [],
		getExposure: () => "direct",
		getNamespace: () => undefined,
		getPromptGuidelines: () => [],
	})?.descriptions?.codemode
}

it("prepends the selection rule to Pi's generated codemode description", () => {
	const description = codemodeDescription()
	expect(description?.startsWith(`${CODEMODE_SELECTION_GUIDANCE}\n\n`)).toBe(true)
	expect(description).toContain("Run JavaScript that calls other tools")
})

it("steers filtering and mechanical chains to codemode, independent full-result calls to direct tools", () => {
	expect(CODEMODE_SELECTION_GUIDANCE).toContain("filter large output")
	expect(CODEMODE_SELECTION_GUIDANCE).toContain("chain calls whose arguments follow mechanically")
	expect(CODEMODE_SELECTION_GUIDANCE).toContain("call tools directly in one turn")
	// No worked example script: it cost ~250 tokens per request without moving adoption.
	expect(codemodeDescription()).not.toContain("const hits")
	// A chaining script has to parse grep output; the format is stated instead.
	expect(CODEMODE_SELECTION_GUIDANCE).toContain("`path:line: text`")
})
