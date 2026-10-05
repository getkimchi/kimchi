import type { Terminal } from "@earendil-works/pi-tui"
import { vi } from "vitest"

/**
 * Shared minimal fake terminal satisfying the pi-tui Terminal interface.
 * Everything written is captured in `writes`; input, resizing, and cursor
 * visibility methods are no-ops. Used by the pi-tui patch regression tests
 * (scrollback flag, wheel-scroll speed).
 */
export function makeMockTerminal(): { writes: string[]; terminal: Terminal } {
	const writes: string[] = []
	return {
		writes,
		terminal: {
			start: vi.fn(),
			stop: vi.fn(),
			drainInput: vi.fn().mockResolvedValue(undefined),
			write: vi.fn((data: string) => writes.push(data)),
			columns: 80,
			rows: 24,
			kittyProtocolActive: false,
			moveBy: vi.fn(),
			hideCursor: vi.fn(),
			showCursor: vi.fn(),
			clearLine: vi.fn(),
			clearFromCursor: vi.fn(),
			clearScreen: vi.fn(),
			setTitle: vi.fn(),
			setProgress: vi.fn(),
		} as unknown as Terminal,
	}
}
