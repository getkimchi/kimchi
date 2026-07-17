import type { Api, Model } from "@earendil-works/pi-ai"
import type {
	ContextUsage,
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
		ui: {
			input: vi.fn(),
			select: vi.fn(),
			editor: vi.fn(),
			notify: vi.fn(),
			custom: vi.fn(),
			setStatus: vi.fn(),
			setWorkingVisible: vi.fn(),
			...overrides?.ui,
		} as unknown as ExtensionUIContext,
		sessionManager: {
			getSessionId: () => "test-session",
			getEntries: () => [],
			getHeader: () => null,
			...overrides?.sessionManager,
		} as SessionManager,
	} as unknown as ExtensionContext
}
