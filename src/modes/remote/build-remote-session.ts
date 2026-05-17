import { ExtensionRunner } from "@earendil-works/pi-coding-agent"
import type { AgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent"
import { ReconnectSupervisor } from "./reconnect.js"
import { RemoteAgentSession } from "./remote-agent-session.js"

export interface BuildRemoteAgentSessionOptions {
	sessionId: string
	apiKey: string
	endpoint?: string
	services: AgentSessionServices
	sessionManager: SessionManager
	cwd: string
}

/**
 * Construct a `RemoteAgentSession` connected to the cloud for the given
 * `sessionId`. Used both by the top-level `--remote` runtime factory and by
 * the teleport orchestrators that spawn / re-attach remotes mid-session.
 *
 * The returned session has its WS already open and is wired to swap RPC
 * clients on reconnect. Permission-mode forwarding (the `onPermissionsModeChange`
 * subscription in `createRemoteRuntimeFactory`) is the caller's concern — keep
 * it scoped to the top-level factory so per-orchestrator spawns don't
 * accumulate global subscribers.
 */
export async function buildRemoteAgentSession(options: BuildRemoteAgentSessionOptions): Promise<RemoteAgentSession> {
	const supervisor = new ReconnectSupervisor({
		sessionId: options.sessionId,
		apiKey: options.apiKey,
		endpoint: options.endpoint,
	})

	const client = await supervisor.connect()

	const extensionsResult = options.services.resourceLoader.getExtensions()
	const extensionRunner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		options.cwd,
		options.sessionManager,
		options.services.modelRegistry,
	)

	const session = new RemoteAgentSession({
		rpcClient: client,
		supervisor,
		settingsManager: options.services.settingsManager,
		sessionManager: options.sessionManager,
		resourceLoader: options.services.resourceLoader,
		modelRegistry: options.services.modelRegistry,
		extensionRunner,
	})

	supervisor.onClientChange = (newClient) => {
		session.swapRpcClient(newClient)
	}

	return session
}
