import { resolve } from "node:path"
import { AuthStorage, ExtensionRunner, createAgentSessionServices } from "@earendil-works/pi-coding-agent"
import type { AgentSession, CreateAgentSessionRuntimeFactory, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { onPermissionsModeChange } from "../../extensions/permissions/index.js"
import { ReconnectSupervisor } from "./reconnect.js"
import { RemoteAgentSession } from "./remote-agent-session.js"

export interface CreateRemoteRuntimeFactoryOptions {
	apiKey: string
	endpoint?: string
	extensionFactories?: ExtensionFactory[]
	agentDir?: string
}

/**
 * Build the `CreateAgentSessionRuntimeFactory` used by `--remote`.
 *
 * Mirrors pi-mono's inner `createRuntime` (main.js:409-474) — same call to
 * `createAgentSessionServices`, same diagnostic collection — but swaps the
 * local `createAgentSessionFromServices` step for a `RemoteAgentSession`
 * backed by an authenticated WebSocket transport.
 *
 * The session id passed to the cloud `:authenticate` endpoint is the
 * pi-mono-minted id from `sessionManager` so reconnect is idempotent.
 */
export function createRemoteRuntimeFactory(
	options: CreateRemoteRuntimeFactoryOptions,
): CreateAgentSessionRuntimeFactory {
	return async (opts) => {
		const { cwd, agentDir, sessionManager } = opts

		const authStorage = AuthStorage.create(resolve(agentDir, "auth.json"))
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			extensionFlagValues: new Map(),
			resourceLoaderOptions: {
				extensionFactories: options.extensionFactories ?? [],
			},
		})

		const supervisor = new ReconnectSupervisor({
			sessionId: sessionManager.getSessionId() ?? "remote-session",
			apiKey: options.apiKey,
			endpoint: options.endpoint,
		})

		const client = await supervisor.connect()

		// `resourceLoader.getExtensions()` returns the LoadExtensionsResult
		// that pi-mono's `CreateAgentSessionRuntimeResult` requires.  No
		// additional loading needed — `createAgentSessionServices` already ran
		// the loader.
		const extensionsResult = services.resourceLoader.getExtensions()
		const loaderDiagnostics = extensionsResult.errors.map(({ path, error }) => ({
			type: "error" as const,
			message: `Failed to load extension "${path}": ${error}`,
		}))

		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			sessionManager,
			services.modelRegistry,
		)

		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor,
			settingsManager: services.settingsManager,
			sessionManager,
			resourceLoader: services.resourceLoader,
			modelRegistry: services.modelRegistry,
			extensionRunner,
		})

		supervisor.onClientChange = (newClient) => {
			session.swapRpcClient(newClient)
		}

		// Forward client-side permission mode changes (CLI flags at startup,
		// shift+tab cycling) to the server so its permissions-extension instance
		// gates tool calls under the same mode.
		onPermissionsModeChange((mode) => {
			void session.setPermissionMode(mode)
		})

		return {
			session: session as unknown as AgentSession,
			extensionsResult,
			services,
			diagnostics: [...services.diagnostics, ...loaderDiagnostics],
		}
	}
}
