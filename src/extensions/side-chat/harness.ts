/**
 * Harness seams for the side chat (TUI fullscreen only).
 *
 * Upstream `InteractiveMode` owns the fullscreen layout root and the
 * `TuiAltScreen` renderer owns text selection, and neither exposes an
 * extension API for a second pane. This module patches both prototypes with
 * three small, inert-by-default hooks:
 *
 * - a host bridge onto the live `InteractiveMode` (layout root swap, focus,
 *   editor theme, markdown theme, tool renderers, active selection text);
 * - post-layout compositors that may paint over the frame (before overlays,
 *   selection highlight and flashes are applied);
 * - mouse interceptors that may consume a raw SGR mouse event before the
 *   renderer dispatches it;
 * - focus guards that re-focus a modal dialog after mouse dispatch (mouse
 *   clicks refocus the clicked editor directly, without going through
 *   `focusComponent`, and a keyboard-only permission ask has no way back);
 * - wheel interceptors that may consume a wheel scroll before it is routed
 *   (upstream chains leftover wheel delta into the primary transcript even
 *   from an `overscroll: "contain"` view).
 *
 * Nothing changes until an extension registers a compositor/interceptor or
 * mounts a side panel. Upstream internals touched here are private members of
 * pi-coding-agent / pi-tui 1.3.0; keep this file the only place that does so.
 * Installation is a no-op (and the side chat reports itself unavailable) when
 * any patched member is missing, so an upstream upgrade degrades the feature
 * instead of breaking the TUI.
 *
 * Tracking: none yet. No upstream issue exists for a split-pane / layout
 * compositor extension API; report it to https://github.com/earendil-works/pi
 * before the side chat leaves the Experimental tab.
 * Removal: once upstream exposes a way to mount a second pane in the
 * fullscreen layout and to observe frame/mouse/wheel/selection events, delete
 * the prototype patches and bind the host to that API.
 */

import { InteractiveMode, type KeybindingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import {
	type Component,
	type EditorTheme,
	HStack,
	isViewportTUI,
	type MarkdownTheme,
	type ScrollView,
	type TUI,
	TuiAltScreen,
} from "@earendil-works/pi-tui"
import type { DecoratableEditor } from "./focus-chrome.js"

export interface LayoutRect {
	x: number
	y: number
	width: number
	height: number
}

/** Structural subset of pi-tui's (non-exported) `LayoutBox`. */
export interface FrameBox {
	component: Component
	rect: LayoutRect
	clip: LayoutRect
	children: FrameBox[]
	scrollView?: ScrollView
}

/** Structural subset of pi-tui's (non-exported) `LayoutFrame`. */
export interface Frame {
	root: FrameBox
	width: number
	height: number
}

/** Raw SGR mouse event as parsed by `TuiAltScreen` (zero-based cells). */
export interface RawMouseEvent {
	button: number
	x: number
	y: number
	release: boolean
}

const MOUSE_MOTION = 32
const MOUSE_WHEEL = 64
const MOUSE_BUTTON_MASK = 3

/** Drag motion with a button held (SGR motion flag). */
export function isMouseMotion(event: RawMouseEvent): boolean {
	return (event.button & MOUSE_MOTION) !== 0
}

/** Left-button press: not a release, not motion, not a wheel tick. */
export function isLeftPress(event: RawMouseEvent): boolean {
	return (
		!event.release && (event.button & (MOUSE_MOTION | MOUSE_WHEEL)) === 0 && (event.button & MOUSE_BUTTON_MASK) === 0
	)
}

export interface SelectionPoint {
	row: number
	col: number
	scrollView?: ScrollView
}

export interface SelectionBounds {
	start: SelectionPoint
	end: SelectionPoint
}

export type Compositor = (screen: string[], frame: Frame, width: number) => string[]
export type MouseInterceptor = (event: RawMouseEvent) => boolean
export type WheelInterceptor = (x: number, y: number, delta: number) => boolean
/** Names a modal dialog that must keep keyboard focus (typically `SideChatHost.modalDialog`), or undefined. */
export type FocusGuard = () => Component | undefined

const compositors = new Set<Compositor>()
const mouseInterceptors = new Set<MouseInterceptor>()
const wheelInterceptors = new Set<WheelInterceptor>()
const focusGuards = new Set<FocusGuard>()

export function addCompositor(compositor: Compositor): () => void {
	compositors.add(compositor)
	return () => compositors.delete(compositor)
}

export function addMouseInterceptor(interceptor: MouseInterceptor): () => void {
	mouseInterceptors.add(interceptor)
	return () => mouseInterceptors.delete(interceptor)
}

export function addWheelInterceptor(interceptor: WheelInterceptor): () => void {
	wheelInterceptors.add(interceptor)
	return () => wheelInterceptors.delete(interceptor)
}

export function addFocusGuard(guard: FocusGuard): () => void {
	focusGuards.add(guard)
	return () => focusGuards.delete(guard)
}

/** Run every registered compositor over a laid-out screen, in registration order. */
export function applyCompositors(screen: string[], frame: Frame, width: number): string[] {
	let result = screen
	for (const compositor of compositors) result = compositor(result, frame, width)
	return result
}

/** Offer a raw mouse event to the interceptors; true when one consumed it. */
export function interceptMouse(event: RawMouseEvent): boolean {
	for (const interceptor of mouseInterceptors) {
		if (interceptor(event)) return true
	}
	return false
}

/** Offer a wheel scroll to the interceptors; true when one consumed it. */
export function interceptWheel(x: number, y: number, delta: number): boolean {
	for (const interceptor of wheelInterceptors) {
		if (interceptor(x, y, delta)) return true
	}
	return false
}

/** The `TUI` focus surface (getFocusedComponent is runtime-present but off the public type). */
export interface FocusReader {
	getFocusedComponent(): Component | null
	setFocus(component: Component | null): void
}

/**
 * Run every focus guard after mouse dispatch; when one names an open modal
 * dialog, make sure it keeps the keyboard focus. Mouse-driven focus changes
 * (an editor answers a click with `focus: true`) otherwise strand the
 * keyboard-only dialog unfocused. True when a guard named a dialog.
 */
export function applyFocusGuards(ui: FocusReader): boolean {
	for (const guard of focusGuards) {
		const dialog = guard()
		if (!dialog) continue
		if (ui.getFocusedComponent() !== dialog) ui.setFocus(dialog)
		return true
	}
	return false
}

/** Depth-first search of a rendered frame. */
export function findBox(box: FrameBox, match: (box: FrameBox) => boolean): FrameBox | undefined {
	if (match(box)) return box
	for (const child of box.children) {
		const found = findBox(child, match)
		if (found) return found
	}
	return undefined
}

/** Laid-out rect of `component` in `frame`, if it was rendered. */
export function rectOf(frame: Frame | undefined, component: Component): LayoutRect | undefined {
	return frame && findBox(frame.root, (box) => box.component === component)?.rect
}

export function rectContains(rect: LayoutRect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

/** Private `TuiAltScreen` members the side chat reads. */
interface AltScreenInternals {
	currentLayout?: Frame
	selectionPressActive: boolean
	getSelectionBounds(): SelectionBounds | undefined
	getActiveSelectionText(): string | undefined
	compositeScrollToEndIndicator(screen: string[], layout: Frame, width: number): string[]
	handleMouseEvent(event: RawMouseEvent): void
	routeWheel(event: { x: number; y: number }, delta: number): void
	requestRender(): void
}

/** Private `InteractiveMode` members the side chat reads. */
interface InteractiveModeInternals {
	ui: TUI
	renderer: TUI
	keybindings: KeybindingsManager
	editor: DecoratableEditor & Component
	defaultEditor: Component & { theme: EditorTheme; onExtensionShortcut?: (data: string) => boolean }
	fullscreenLayoutRoot?: Component
	outputPad: number
	/** Main-session modal dialogs shown in the editor slot (permission asks come through `ctx.ui.select`). */
	extensionSelector?: Component
	extensionInput?: Component
	extensionEditor?: Component
	/**
	 * The editor slot's container: it holds `editor`, swapped for the active
	 * dialog. Selector/input/editor dialogs are ALSO tracked in the members
	 * above, but a `ctx.ui.custom` component (the questionnaire form) replaces
	 * the editor without any tracked member — detectable here as "the slot's
	 * only child is not the editor".
	 */
	editorContainer?: { children: Component[] }
	init(): Promise<void>
	getMarkdownThemeWithSettings(): MarkdownTheme
	getRegisteredToolDefinition(name: string): ToolDefinition | undefined
}

const altProto = TuiAltScreen.prototype as unknown as AltScreenInternals
const imProto = InteractiveMode.prototype as unknown as InteractiveModeInternals

let activeMode: InteractiveModeInternals | undefined
let baseLayoutRoot: Component | undefined
let installState: "pending" | "installed" | "incompatible" = "pending"

const PATCHED_ALT_SCREEN_METHODS = [
	"compositeScrollToEndIndicator",
	"handleMouseEvent",
	"routeWheel",
	"getSelectionBounds",
	"getActiveSelectionText",
] as const
const PATCHED_INTERACTIVE_MODE_METHODS = [
	"init",
	"getMarkdownThemeWithSettings",
	"getRegisteredToolDefinition",
] as const

/** Private members of the pinned upstream that this module needs but that are gone. */
export function missingHarnessMembers(): string[] {
	const missing = (proto: object, owner: string, names: readonly string[]) =>
		names.filter((name) => typeof Reflect.get(proto, name) !== "function").map((name) => `${owner}.${name}`)
	return [
		...missing(altProto, "TuiAltScreen", PATCHED_ALT_SCREEN_METHODS),
		...missing(imProto, "InteractiveMode", PATCHED_INTERACTIVE_MODE_METHODS),
	]
}

/**
 * Patch the upstream prototypes once per process. Must run before
 * `InteractiveMode.init` (extension factories load first). Returns false when
 * the installed upstream lacks a patched member.
 */
export function installSideChatHarnessPatch(): boolean {
	if (installState !== "pending") return installState === "installed"
	if (missingHarnessMembers().length > 0) {
		installState = "incompatible"
		return false
	}
	installState = "installed"

	const originalInit = imProto.init
	imProto.init = async function patchedInit(this: InteractiveModeInternals) {
		activeMode = this
		baseLayoutRoot = undefined
		return originalInit.call(this)
	}

	const originalComposite = altProto.compositeScrollToEndIndicator
	altProto.compositeScrollToEndIndicator = function patchedComposite(
		this: AltScreenInternals,
		screen: string[],
		layout: Frame,
		width: number,
	) {
		return applyCompositors(originalComposite.call(this, screen, layout, width), layout, width)
	}

	const originalHandleMouse = altProto.handleMouseEvent
	altProto.handleMouseEvent = function patchedHandleMouse(this: AltScreenInternals, event: RawMouseEvent) {
		if (interceptMouse(event)) return
		originalHandleMouse.call(this, event)
		if (activeMode) applyFocusGuards(activeMode.ui as unknown as FocusReader)
	}

	const originalRouteWheel = altProto.routeWheel
	altProto.routeWheel = function patchedRouteWheel(this: AltScreenInternals, event: { x: number; y: number }, delta) {
		if (interceptWheel(event.x, event.y, delta)) this.requestRender()
		else originalRouteWheel.call(this, event, delta)
	}
	return true
}

function altScreen(): AltScreenInternals | undefined {
	const renderer = activeMode?.renderer
	return renderer instanceof TuiAltScreen ? (renderer as unknown as AltScreenInternals) : undefined
}

export interface SidePanelLayout {
	/** 1-column divider between the panes. */
	divider: Component
	/** Pinned panel width; without it the panes split 60/40. */
	width?: number
}

export const SIDE_PANEL_MIN_WIDTH = 28
export const MAIN_PANEL_MIN_WIDTH = 30

/** Live view onto the interactive session, available once `InteractiveMode.init` ran. */
export interface SideChatHost {
	readonly ui: TUI
	readonly keybindings: KeybindingsManager
	readonly editorTheme: EditorTheme
	readonly outputPad: number
	isFullscreen(): boolean
	markdownTheme(): MarkdownTheme
	toolDefinition(name: string): ToolDefinition | undefined
	mainEditor(): DecoratableEditor
	/**
	 * The main session's active modal dialog: a permission ask (`ctx.ui.select`),
	 * an extension input/editor, a `ctx.ui.custom` dialog in the editor slot (the
	 * questionnaire form), or a focus-capturing overlay (plan review, /help).
	 * While one is open it owns the keyboard;
	 * all side-chat focus transitions must go through `focusComponent` — the
	 * dialogs have no mouse support, so once unfocused there is no way back to
	 * them and the session deadlocks on an unanswerable ask.
	 */
	modalDialog(): Component | undefined
	/** Focus `component`, unless a main-session modal dialog is open — then (re)focus the dialog instead. */
	focusComponent(component: Component): void
	focusMainEditor(): void
	/** Route a key to the main editor's extension-shortcut table (so shortcuts work from any pane). */
	forwardExtensionShortcut(data: string): boolean
	/** Mount `panel` to the right of the main layout, after `layout.divider`. */
	setSidePanel(panel: Component, layout: SidePanelLayout): void
	/** Restore the original single-pane layout. */
	clearSidePanel(): void
	frame(): Frame | undefined
	/** Active selection, only once the mouse button was released. */
	settledSelection(): { bounds: SelectionBounds; text: string } | undefined
	clearSelection(): void
	requestRender(): void
}

function mountLayoutRoot(mode: InteractiveModeInternals, build: (base: Component) => Component): void {
	baseLayoutRoot ??= mode.fullscreenLayoutRoot
	if (!baseLayoutRoot) return
	const root = build(baseLayoutRoot)
	mode.fullscreenLayoutRoot = root
	if (isViewportTUI(mode.renderer)) mode.renderer.setLayoutRoot(root)
	mode.ui.requestRender()
}

/** Private `TUI` members the side chat reads (declared `private` upstream). */
interface TuiOverlayInternals {
	getTopmostVisibleOverlay?(): { component: Component } | undefined
}

/** Structural slice of `InteractiveMode` that modal-dialog resolution reads. */
export interface ModalDialogSource {
	ui: object
	editor: Component
	extensionSelector?: Component
	extensionInput?: Component
	extensionEditor?: Component
	editorContainer?: { children: Component[] }
}

/**
 * The main session's active keyboard-only modal dialog, if any: a tracked
 * selector/input/editor dialog (permission asks come through `ctx.ui.select`),
 * the topmost focus-capturing overlay (plan review, feedback, /help), or a
 * `ctx.ui.custom` dialog mounted in the editor slot — upstream keeps that one
 * in a local closure (`showExtensionCustom`), so the only observable trace is
 * that the slot's child is no longer the editor. Non-capturing overlays and a
 * slot holding the plain editor both resolve to undefined.
 */
export function resolveModalDialog(mode: ModalDialogSource): Component | undefined {
	if (mode.extensionSelector) return mode.extensionSelector
	if (mode.extensionInput) return mode.extensionInput
	if (mode.extensionEditor) return mode.extensionEditor
	const overlay = (mode.ui as TuiOverlayInternals).getTopmostVisibleOverlay?.()
	if (overlay) return overlay.component
	const child = mode.editorContainer?.children[0]
	return child && child !== mode.editor ? child : undefined
}

/** The live interactive session; undefined before `InteractiveMode.init`, outside the TUI, or when not installed. */
export function getSideChatHost(): SideChatHost | undefined {
	const mode = installState === "installed" ? activeMode : undefined
	if (!mode) return undefined
	const modalDialog = () => resolveModalDialog(mode)
	const focusComponent = (component: Component) => {
		mode.ui.setFocus(modalDialog() ?? component)
		mode.ui.requestRender()
	}
	return {
		ui: mode.ui,
		keybindings: mode.keybindings,
		editorTheme: mode.defaultEditor.theme,
		outputPad: mode.outputPad,
		isFullscreen: () => isViewportTUI(mode.renderer),
		markdownTheme: () => mode.getMarkdownThemeWithSettings(),
		toolDefinition: (name) => mode.getRegisteredToolDefinition(name),
		mainEditor: () => mode.editor,
		modalDialog,
		focusComponent,
		focusMainEditor: () => focusComponent(mode.editor),
		forwardExtensionShortcut: (data) => mode.defaultEditor.onExtensionShortcut?.(data) ?? false,
		setSidePanel: (panel, { divider, width }) => {
			mountLayoutRoot(
				mode,
				(base) =>
					new HStack([
						{ component: base, basis: 0, grow: 3, shrink: 1, minSize: MAIN_PANEL_MIN_WIDTH },
						{ component: divider, basis: 1, grow: 0, shrink: 0, minSize: 1 },
						width === undefined
							? { component: panel, basis: 0, grow: 2, shrink: 1, minSize: SIDE_PANEL_MIN_WIDTH }
							: { component: panel, basis: width, grow: 0, shrink: 1, minSize: SIDE_PANEL_MIN_WIDTH },
					]),
			)
		},
		clearSidePanel: () => mountLayoutRoot(mode, (base) => base),
		frame: () => altScreen()?.currentLayout,
		settledSelection: () => {
			const screen = altScreen()
			if (!screen || screen.selectionPressActive) return undefined
			const bounds = screen.getSelectionBounds()
			const text = bounds ? screen.getActiveSelectionText() : undefined
			return bounds && text ? { bounds, text } : undefined
		},
		clearSelection: () => {
			const renderer = mode.renderer
			if (renderer instanceof TuiAltScreen) renderer.resetTextSelection()
		},
		requestRender: () => mode.ui.requestRender(),
	}
}
