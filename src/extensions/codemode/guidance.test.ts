import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { CODEMODE_GREP_READ_EXAMPLE, CODEMODE_SELECTION_GUIDANCE, createGuidedCodemodeExtension } from "./guidance.js"

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
	expect(changes?.descriptions?.codemode).toContain(CODEMODE_GREP_READ_EXAMPLE)
	expect(changes?.descriptions?.codemode).toContain("Run JavaScript that calls other tools")
	expect(codemode.defaultActive).toBe(false)
})

it("the described script reads bounded ranges derived from grep hits", async () => {
	const calls: Array<{ path: string; offset: number; limit: number }> = []
	const output: string[] = []
	await runInNewContext(`(async () => { ${CODEMODE_GREP_READ_EXAMPLE} })()`, {
		tools: {
			grep: async () => "src/a.ts:2: mySymbol()\nsrc/b.ts:20: mySymbol()\nmalformed line",
			read: async (args: { path: string; offset: number; limit: number }) => {
				calls.push(args)
				return `excerpt from ${args.path}`
			},
		},
		text: (value: string) => output.push(value),
	})

	expect(calls).toEqual([
		{ path: "src/a.ts", offset: 1, limit: 9 },
		{ path: "src/b.ts", offset: 16, limit: 9 },
	])
	expect(output).toEqual(["src/a.ts:2\nexcerpt from src/a.ts", "src/b.ts:20\nexcerpt from src/b.ts"])
})

it("the described script handles no parseable matches and read failures", async () => {
	const output: string[] = []
	const run = (grepResult: string) =>
		runInNewContext(`(async () => { ${CODEMODE_GREP_READ_EXAMPLE} })()`, {
			tools: {
				grep: async () => grepResult,
				read: async () => {
					throw new Error("unavailable")
				},
			},
			text: (value: string) => output.push(value),
		})

	await run("No matches found\nmalformed line")
	expect(output).toEqual(["No parseable matches"])
	output.length = 0
	await run("src/a.ts:12: mySymbol()")
	expect(output).toEqual(["src/a.ts:12\nERROR: Error: unavailable"])
})
