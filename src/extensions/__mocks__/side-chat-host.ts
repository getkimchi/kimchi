import type { Component } from "@earendil-works/pi-tui"
import { vi } from "vitest"
import type { Frame, FrameBox, LayoutRect, SelectionBounds, SideChatHost } from "../side-chat/harness.js"

/** Frame box for `component` at `rect`, with optional children. */
export function frameBox(component: Component, rect: LayoutRect, children: FrameBox[] = []): FrameBox {
	return { component, rect, clip: rect, children }
}

/** Laid-out frame of `width`×`height` whose root holds `children`. */
export function frameOf(width: number, height: number, children: FrameBox[]): Frame {
	const root: Component = { render: () => [], invalidate: () => {} }
	return { root: frameBox(root, { x: 0, y: 0, width, height }, children), width, height }
}

/**
 * Side chat host for unit tests: no live TUI, a settable frame and selection.
 * Methods are `vi.fn` so tests can assert on focus/render/selection calls.
 */
export function createSideChatHost(): {
	host: SideChatHost
	setFrame(frame: Frame | undefined): void
	setSelection(selection: { bounds: SelectionBounds; text: string } | undefined): void
} {
	let frame: Frame | undefined
	let selection: { bounds: SelectionBounds; text: string } | undefined
	const host = {
		isFullscreen: vi.fn(() => true),
		focusMainEditor: vi.fn(),
		forwardExtensionShortcut: vi.fn(() => false),
		setSidePanel: vi.fn(),
		clearSidePanel: vi.fn(),
		frame: vi.fn(() => frame),
		settledSelection: vi.fn(() => selection),
		clearSelection: vi.fn(() => {
			selection = undefined
		}),
		requestRender: vi.fn(),
	} as unknown as SideChatHost
	return {
		host,
		setFrame: (next) => {
			frame = next
		},
		setSelection: (next) => {
			selection = next
		},
	}
}
