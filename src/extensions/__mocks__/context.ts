import type { Api, Model } from "@earendil-works/pi-ai"
import type {
	ContextUsage,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent"
import { type Mocked, vi } from "vitest"

export function createContext(
	overrides?: Mocked<
		Omit<Partial<ExtensionContext>, "ui" | "sessionManager" | "modelRegistry" | "model" | "getContextUsage"> & {
			ui?: Partial<ExtensionUIContext>
			sessionManager?: Partial<SessionManager>
			getContextUsage?(): Partial<ContextUsage> | undefined
			model?: Partial<Model<Api>>
			modelRegistry?: Omit<Partial<ModelRegistry>, "find" | "getAvailable"> & {
				find?(provider: string, modelId: string): Partial<Model<Api>> | undefined
				getAvailable?(): Partial<Model<Api>>[]
			}
		}
	>,
): ExtensionContext {
	return {
		hasUI: true,
		mode: "tui",
		cwd: "/tmp",
		isIdle: vi.fn(),
		getContextUsage: vi.fn().mockReturnValue(undefined),
		...overrides,
		model: overrides?.model
			? {
					provider: "kimchi-dev",
					name: overrides.model.name ?? overrides?.model.id,
					...overrides.model,
				}
			: undefined,
		ui: {
			input: vi.fn(),
			select: vi.fn(),
			editor: vi.fn(),
			notify: vi.fn(),
			custom: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			setWorkingVisible: vi.fn(),
			...overrides?.ui,
		} as unknown as ExtensionUIContext,
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionDir: () => "",
			getSessionFile: () => undefined,
			getEntries: () => [],
			getBranch: () => [],
			getHeader: () => null,
			...overrides?.sessionManager,
		} as SessionManager,
	} as unknown as ExtensionContext
}

/**
 * Command-handler ctx — createContext plus the session-control surface
 * (ExtensionCommandContext). The stubs cover what command tests touch;
 * the cast mirrors createContext's mock pattern.
 */
export function createCommandContext(): ExtensionCommandContext {
	return {
		...createContext(),
		getSystemPromptOptions: vi.fn(),
		waitForIdle: vi.fn(async () => {}),
		newSession: vi.fn(async () => ({ cancelled: false })),
	} as unknown as ExtensionCommandContext
}
