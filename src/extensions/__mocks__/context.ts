import type { Api, Model } from "@earendil-works/pi-ai"
import type {
	ContextUsage,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	ModelRegistry,
	SessionManager,
	TerminalInputHandler,
	Theme,
} from "@earendil-works/pi-coding-agent"
import type { Component, TUI } from "@earendil-works/pi-tui"
import { type Mocked, vi } from "vitest"

export function createCommandContext(): ExtensionCommandContext {
	return {
		...createContext(),
		getSystemPromptOptions: vi.fn(() => ({ cwd: "/tmp" })),
		waitForIdle: vi.fn(async () => {}),
		newSession: vi.fn(async () => ({ cancelled: false })),
		fork: vi.fn(async () => ({ cancelled: false })),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
		switchSession: vi.fn(async () => ({ cancelled: false })),
		reload: vi.fn(async () => {}),
	}
}

/** Dispatch raw terminal data to every handler an extension has subscribed. */
export function sendTerminalInput(ctx: ExtensionContext, data: string): void {
	const handlers = (ctx as unknown as { __terminalInputHandlers?: Set<TerminalInputHandler> }).__terminalInputHandlers
	for (const handler of handlers ?? []) {
		handler(data)
	}
}

/**
 * Instantiate the component factory most recently passed to
 * `ctx.ui.setWidget(key, factory)`. Returns undefined when the widget was
 * never set or was last cleared.
 */
export function mountWidget(
	ctx: ExtensionContext,
	key: string,
	tui: Partial<TUI> = { requestRender: vi.fn() },
): Component | undefined {
	const calls = vi.mocked(ctx.ui.setWidget).mock.calls.filter(([k]) => k === key)
	const content = calls.at(-1)?.[1]
	if (typeof content !== "function") return undefined
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme
	return content(tui as TUI, theme)
}

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
	const terminalInputHandlers = new Set<TerminalInputHandler>()
	return {
		__terminalInputHandlers: terminalInputHandlers,
		hasUI: true,
		mode: "tui",
		cwd: "/tmp",
		scopedModels: [],
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
			confirm: vi.fn(),
			editor: vi.fn(),
			notify: vi.fn(),
			custom: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			getToolsExpanded: vi.fn(() => false),
			setWorkingVisible: vi.fn(),
			setEditorText: vi.fn(),
			getEditorText: vi.fn(() => ""),
			// Real contract: returns an unsubscribe function. Handlers are kept
			// on `__terminalInputHandlers` so tests can dispatch raw key data
			// via `sendTerminalInput()`.
			onTerminalInput: vi.fn((handler: TerminalInputHandler) => {
				terminalInputHandlers.add(handler)
				return () => terminalInputHandlers.delete(handler)
			}),
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
