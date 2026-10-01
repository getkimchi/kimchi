import { format } from "node:util"
import { InteractiveMode, SessionSelectorComponent } from "@earendil-works/pi-coding-agent"
import { type Component, type Container, TuiAltScreen, type TuiStopOptions, VStack } from "@earendil-works/pi-tui"
import { LAYOUT_NODE } from "@earendil-works/pi-tui/dist/layout-node.js"

// Pi 0.85.1 defers viewport keys to overlays, but not to inline selectors.
// Keep this private boundary here until Pi routes keys to the focused dock.
interface ViewportInput {
	getFocusedComponent(): Component | null
	shouldDeferViewportInputToOverlay(): boolean
}
const viewport = TuiAltScreen.prototype as unknown as ViewportInput
const defer = viewport.shouldDeferViewportInputToOverlay
viewport.shouldDeferViewportInputToOverlay = function () {
	return defer.call(this) || this.getFocusedComponent() instanceof SessionSelectorComponent
}

export function routeFullscreenWarnings(
	tui: Pick<TuiAltScreen, "start" | "stop">,
	notify: (message: string, type: "warning" | "error") => void,
): void {
	const start = tui.start.bind(tui)
	const stop = tui.stop.bind(tui)
	let restore: (() => void) | undefined
	tui.start = () => {
		start()
		if (restore) return
		const { warn, error } = console
		console.warn = (...args) => notify(format(...args), "warning")
		console.error = (...args) => notify(format(...args), "error")
		restore = () => {
			console.warn = warn
			console.error = error
		}
	}
	tui.stop = (options?: TuiStopOptions) => {
		restore?.()
		restore = undefined
		stop(options)
	}
}

// Mount runs on startup and renderer switches; start/stop also cover external editors.
// Use Pi's notifications instead of writing stderr over its alternate-screen frame.
interface InteractiveMount {
	editorContainer: Container
	mountInteractiveTui(tui: TuiAltScreen, components: Component[]): void
	showExtensionNotify(message: string, type: "warning" | "error"): void
}
const mode = InteractiveMode.prototype as unknown as InteractiveMount
const mount = mode.mountInteractiveTui
mode.mountInteractiveTui = function (tui, components) {
	// Pi's legacy editor container otherwise flattens custom layout components,
	// preventing their scroll views from receiving the dock's available height.
	Object.assign(this.editorContainer, {
		[LAYOUT_NODE]: () => new VStack(this.editorContainer.children)[LAYOUT_NODE](),
	})
	mount.call(this, tui, components)
	if (tui instanceof TuiAltScreen) {
		routeFullscreenWarnings(tui, (message, type) => this.showExtensionNotify(message, type))
	}
}
