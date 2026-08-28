import "../integrations/hermes.js" // side-effect: register integration
import { byId } from "../integrations/registry.js"
import { popScope, prepareTool } from "./_helpers.js"

export async function runHermes(args: string[]): Promise<number> {
	const scope = popScope(args)
	const prepped = await prepareTool("hermes", "override")
	if (!prepped) return 1

	try {
		const tool = byId("hermes")
		if (!tool) {
			console.error("kimchi hermes: integration not registered")
			return 1
		}
		await tool.write(scope, prepped.apiKey, prepped.models)
		console.log("kimchi hermes: configuration written.")
		return 0
	} catch (err) {
		console.error(`kimchi hermes: ${(err as Error).message}`)
		return 1
	}
}
