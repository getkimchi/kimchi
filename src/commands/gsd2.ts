import "../integrations/gsd2.js" // side-effect: register integration
import { byId } from "../integrations/registry.js"
import { popScope, prepareTool } from "./_helpers.js"

export async function runGsd2(args: string[]): Promise<number> {
	const scope = popScope(args)
	const prepped = await prepareTool("gsd2", "override")
	if (!prepped) return 1

	try {
		const tool = byId("gsd2")
		if (!tool) {
			console.error("kimchi gsd2: integration not registered")
			return 1
		}
		await tool.write(scope, prepped.apiKey, prepped.models)
		console.log("kimchi gsd2: configuration written. Run `gsd` to use kimchi-routed models.")
		return 0
	} catch (err) {
		console.error(`kimchi gsd2: ${(err as Error).message}`)
		return 1
	}
}
