import "@earendil-works/pi-coding-agent"

declare module "@earendil-works/pi-coding-agent" {
	interface ExtensionContext {
		mode: "rpc" | "tui"
	}
}
