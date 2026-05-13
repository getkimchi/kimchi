import "../integrations/openclaw.js" // side-effect: register integration
import { byId } from "../integrations/registry.js"
import { popScope, prepareTool } from "./_helpers.js"

export async function runOpenClaw(args: string[]): Promise<number> {
	const scope = popScope(args)
	const prepped = await prepareTool("openclaw", "override")
	if (!prepped) return 1

	try {
		const tool = byId("openclaw")
		if (!tool) {
			console.error("kimchi openclaw: integration not registered")
			return 1
		}
		await tool.write(scope, prepped.apiKey, prepped.models)
		console.log("kimchi openclaw: configuration written.")
		return 0
	} catch (err) {
		console.error(`kimchi openclaw: ${(err as Error).message}`)
		return 1
	}
}
