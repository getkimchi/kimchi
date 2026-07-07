import type { ExtensionContext, ExtensionUIContext, SessionManager } from "@earendil-works/pi-coding-agent"
import { vi } from "vitest"

export function createContext(
	overrides?: Omit<Partial<ExtensionContext>, "ui" | "sessionManager"> & {
		ui?: Partial<ExtensionUIContext>
		sessionManager?: Partial<SessionManager>
	},
): ExtensionContext {
	return {
		hasUI: true,
		mode: "tui",
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
			...overrides?.sessionManager,
		} as SessionManager,
	} as unknown as ExtensionContext
}
