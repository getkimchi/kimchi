import type { Extension, SourceInfo } from "@mariozechner/pi-coding-agent"

export function registerCuratorExtension(): Extension {
	return {
		path: "curator",
		resolvedPath: "",
		sourceInfo: {} as SourceInfo,
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	}
}
