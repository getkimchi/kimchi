import { getResourceDefinitions } from "../resources/definitions.js"
import {
	isResourceEnabled,
	isResourceLocked,
	orgLockMessage,
	resetResourceOverride,
	setResourceOverride,
} from "../resources/store.js"

export async function runResources(args: string[]): Promise<number> {
	const [sub, id, value] = args
	switch (sub) {
		case undefined:
		case "list":
		case "status":
			printResources()
			return 0
		case "enable":
		case "disable":
			if (!id) return usage(2)
			if (refuseOrgLocked(id)) return 1
			setResourceOverride(id, sub === "enable")
			console.log(`${id}: ${sub === "enable" ? "enabled" : "disabled"}`)
			return 0
		case "set":
			if (!id || !value) return usage(2)
			{
				const enabled = parseSwitch(value)
				if (enabled === null) return usage(2)
				if (refuseOrgLocked(id)) return 1
				setResourceOverride(id, enabled)
				console.log(`${id}: ${enabled ? "enabled" : "disabled"}`)
				return 0
			}
		case "reset":
			if (!id) return usage(2)
			if (refuseOrgLocked(id)) return 1
			resetResourceOverride(id)
			console.log(`${id}: reset`)
			return 0
		case "--help":
		case "-h":
		case "help":
			return usage(0)
		default:
			return usage(2)
	}
}

function printResources(): void {
	for (const resource of getResourceDefinitions()) {
		const status = isResourceEnabled(resource.id) ? "enabled " : "disabled"
		const lock = isResourceLocked(resource.id) ? " [org-locked]" : ""
		console.log(`${status}  ${resource.id}${lock}  ${resource.description}`)
	}
}

/** Print a clear refusal for org-locked resources; the caller exits nonzero. */
function refuseOrgLocked(id: string): boolean {
	if (!isResourceLocked(id)) return false
	console.error(orgLockMessage(id))
	return true
}

function parseSwitch(value: string): boolean | null {
	switch (value.toLowerCase()) {
		case "on":
		case "true":
		case "yes":
		case "1":
		case "enable":
		case "enabled":
			return true
		case "off":
		case "false":
		case "no":
		case "0":
		case "disable":
		case "disabled":
			return false
		default:
			return null
	}
}

function usage(code: number): number {
	const out = code === 0 ? console.log : console.error
	out("Usage: kimchi resources [list|status]")
	out("       kimchi resources enable <resource-id>")
	out("       kimchi resources disable <resource-id>")
	out("       kimchi resources set <resource-id> on|off")
	out("       kimchi resources reset <resource-id>")
	return code
}
