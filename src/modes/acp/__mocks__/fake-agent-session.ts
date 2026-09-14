import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { AgentSession, ResourceLoader } from "@earendil-works/pi-coding-agent"
import { vi } from "vitest"
import type { AcpSessionFactory } from "../server.js"

// Shared scaffold for KimchiAcpAgent ext-method tests. Suites extend this
// base and override only the methods their behavior needs (e.g. prompt()
// semantics, steer/clearQueue). modelRegistry reports auth as always
// configured: session/new gates on assertSessionModelHasAuth, and these
// suites test extension methods, not the auth gate.
export class BaseFakeAgentSession {
	sessionId: string
	disposed = false
	model = { provider: "test", id: "test-model" }
	modelRegistry = {
		getAvailable: () => [{ provider: "test", id: "test-model", name: "Test" }],
		find: (provider: string, id: string) =>
			this.modelRegistry.getAvailable().find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (_model: { provider: string }) => true,
	}
	sessionManager = {
		getBranch: () => [],
		getSessionId: () => this.sessionId,
		getEntries: () => [],
		getSessionDir: () => "/tmp",
		getCwd: () => "/tmp",
		appendCustomEntry: () => "entry-id",
	}
	setSessionName = vi.fn()
	extensionRunner = { emit: async () => {} }
	resourceLoader = {
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getExtensions: () => ({ extensions: [], errors: [], runtime: undefined }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	} as unknown as ResourceLoader

	constructor(sessionId: string) {
		this.sessionId = sessionId
	}

	getToolDefinition = vi.fn((_name: string) => undefined)
	setActiveToolsByName = vi.fn()
	subscribe = () => () => {}
	async bindExtensions(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<void> {}
	dispose(): void {
		this.disposed = true
	}
}

export function asSession(fake: BaseFakeAgentSession): AgentSession {
	return fake as unknown as AgentSession
}

export function makeAcpConn(): AgentSideConnection {
	return {
		sessionUpdate: async (_p: SessionNotification) => {},
		extNotification: vi.fn(),
		extMethod: vi.fn(),
		requestPermission: vi.fn(),
		unstable_createElicitation: vi.fn(),
		closed: Promise.resolve(),
	} as unknown as AgentSideConnection
}

export function makeAcpSessionFactory(session: BaseFakeAgentSession): AcpSessionFactory {
	return async () => asSession(session)
}
