import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent"

export type FermentUi = Partial<
	Pick<ExtensionUIContext, "input" | "editor" | "select" | "custom" | "confirm" | "setStatus" | "setWorkingVisible">
> &
	Pick<ExtensionUIContext, "notify">

export type FermentUiContext = Partial<Pick<ExtensionContext, "hasUI" | "mode" | "model" | "modelRegistry">> & {
	ui: FermentUi
}
