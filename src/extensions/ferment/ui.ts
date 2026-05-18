import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent"

export interface FermentUi {
	notify(message: string, level?: string): void
	input?(label: string, placeholder?: string): Promise<string | undefined>
	select?(title: string, options: string[]): Promise<string | undefined>
	custom?: ExtensionUIContext["custom"]
	confirm?(title: string, description?: string): Promise<boolean>
}

export interface FermentUiContext {
	ui: FermentUi
	hasUI?: boolean
	model?: Model<Api>
	modelRegistry?: ModelRegistry
	controller?: unknown
}
