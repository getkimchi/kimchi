import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { DirectorWorkerGateway } from "../director/lifecycle.js"
import type { AgentManager } from "./manager/agent-manager.js"

const gateways = new WeakMap<ExtensionAPI, DirectorWorkerGateway>()

/** Expose lifecycle facts only; Director never receives runtime sessions or controllers. */
export function registerDirectorWorkerGateway(pi: ExtensionAPI, gateway: DirectorWorkerGateway): void {
	gateways.set(pi, gateway)
}

export function getDirectorWorkerGateway(pi: ExtensionAPI): DirectorWorkerGateway {
	return gateways.get(pi) ?? { list: () => [], abort: () => false }
}

/** Expose lifecycle facts only; Director never receives runtime sessions or controllers. */
export function createDirectorWorkerGateway(
	manager: Pick<AgentManager, "listAgents" | "abort">,
): DirectorWorkerGateway {
	return {
		list: () =>
			manager.listAgents().map((record) => ({
				id: record.id,
				type: record.type,
				description: record.description,
				status: record.status,
				remote: record.remote,
				result: record.result,
				error: record.error,
				startedAt: record.startedAt,
				completedAt: record.completedAt,
			})),
		abort: (id) => manager.abort(id),
	}
}
