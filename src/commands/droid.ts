import "../integrations/droid.js" // side-effect: register integration
import { byId } from "../integrations/registry.js"
import { popScope, prepareTool } from "./_helpers.js"

export async function runDroid(args: string[]): Promise<number> {
	const scope = popScope(args)
	const prepped = await prepareTool("droid", "override")
	if (!prepped) return 1

	try {
		const tool = byId("droid")
		if (!tool) {
			console.error("kimchi droid: integration not registered")
			return 1
		}
		await tool.write(scope, prepped.apiKey, prepped.models)
		console.log("kimchi droid: configuration written. Run `droid` and pick a kimchi model with /model.")
		return 0
	} catch (err) {
		console.error(`kimchi droid: ${(err as Error).message}`)
		return 1
	}
}
