import { expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { CODEMODE_SELECTION_GUIDANCE, createGuidedCodemodeExtension } from "./guidance.js"

it("prepends selection guidance to Pi's generated codemode description", () => {
	const mock = createExtensionApi()
	createGuidedCodemodeExtension()(mock.api)
	const codemode = mock.getRegisteredTool("codemode")
	const changes = codemode.prepareLoadout?.({
		declared: [],
		callable: [],
		registered: [],
		getExposure: () => "direct",
		getNamespace: () => undefined,
		getPromptGuidelines: () => [],
	})

	expect(changes?.descriptions?.codemode).toContain(CODEMODE_SELECTION_GUIDANCE)
	expect(changes?.descriptions?.codemode).toContain("Run JavaScript that calls other tools")
	expect(codemode.defaultActive).toBe(false)
})
