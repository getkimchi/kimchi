import { type Component, visibleWidth } from "@earendil-works/pi-tui"

export type BannerPhase = "connecting" | "reconnecting" | "lost" | "fatal"

export interface BannerState {
	phase: BannerPhase
	reconnect?: { attempt: number; secondsRemaining: number }
	fatal?: { code: number; reason: string }
}

const DIM_OPEN = "\x1b[2m"
const DIM_CLOSE = "\x1b[22m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const RESET_FG = "\x1b[39m"

export class ReconnectBanner implements Component {
	constructor(private readonly getState: () => BannerState | null) {}

	render(width: number): string[] {
		const state = this.getState()
		if (!state) return []

		const { plain, styled } = renderBanner(state)
		const truncated = truncate(plain, styled, width)
		const len = visibleWidth(truncated.plain)
		const pad = Math.max(0, width - len)
		return [`${truncated.styled}${" ".repeat(pad)}`]
	}

	invalidate(): void {}
}

function renderBanner(state: BannerState): { plain: string; styled: string } {
	switch (state.phase) {
		case "connecting": {
			const text = "connecting…"
			return { plain: text, styled: `${DIM_OPEN}${text}${DIM_CLOSE}` }
		}
		case "reconnecting": {
			const r = state.reconnect ?? { attempt: 1, secondsRemaining: 0 }
			const text = `reconnecting in ${r.secondsRemaining}s (attempt ${r.attempt})…`
			return { plain: text, styled: `${YELLOW}${text}${RESET_FG}` }
		}
		case "lost": {
			const text = "connection lost — ctrl+r retry · ctrl+d exit"
			return { plain: text, styled: `${RED}${text}${RESET_FG}` }
		}
		case "fatal": {
			const f = state.fatal ?? { code: 0, reason: "session terminated" }
			const reason = f.reason || "session terminated"
			const text = `fatal: ${reason} (${f.code}) — ctrl+d exit`
			return { plain: text, styled: `${RED}${text}${RESET_FG}` }
		}
	}
}

function truncate(plain: string, styled: string, width: number): { plain: string; styled: string } {
	if (visibleWidth(plain) <= width) return { plain, styled }
	if (width <= 1) {
		const slice = plain.slice(0, Math.max(0, width))
		return { plain: slice, styled: slice }
	}
	// Styled strings carry ANSI escapes that we don't try to slice through.
	// Fall back to plain truncation when the line exceeds the width — the
	// banner is a single line so loss of color is preferable to broken escapes.
	const cut = `${plain.slice(0, width - 1)}…`
	return { plain: cut, styled: cut }
}
