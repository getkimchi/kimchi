/**
 * Shared visual primitives — ANSI color helpers and small formatters.
 *
 * Used by progress-overlay.ts (the /progress dropdown) and any tool that needs
 * consistent terminal styling.
 */

import { ORANGE_FG, RST_FG, SUCCESS_FG, TEAL_FG, WARNING_FG } from "../../ansi.js"
import type { Grade, Phase, Step } from "../../ferment/types.js"

// ─── ANSI primitives ──────────────────────────────────────────────────────────

export const DIM = "\x1b[2m"
export const BOLD = "\x1b[1m"
export const RST_ALL = "\x1b[0m"
export { ORANGE_FG, RST_FG, SUCCESS_FG, TEAL_FG, WARNING_FG }

export function pr_teal(s: string): string {
	return `${TEAL_FG}${s}${RST_FG}`
}
export function pr_orange(s: string): string {
	return `${ORANGE_FG}${s}${RST_FG}`
}
export function pr_success(s: string): string {
	return `${SUCCESS_FG}${s}${RST_FG}`
}
export function pr_warn(s: string): string {
	return `${WARNING_FG}${s}${RST_FG}`
}
export function pr_dim(s: string): string {
	return `${DIM}${s}${RST_ALL}`
}
export function pr_bold(s: string): string {
	return `${BOLD}${s}${RST_ALL}`
}

export function truncateLabel(s: string, max = 40): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s ago`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ${m % 60}m ago`
	return `${Math.floor(h / 24)}d ago`
}

export function gradeColor(g: Grade): string {
	switch (g) {
		case "A":
			return pr_success("A")
		case "B":
			return pr_teal("B")
		case "C":
			return pr_warn("C")
		case "D":
			return pr_orange("D")
		case "F":
			return pr_orange("F")
	}
}

export function phaseBullet(p: Phase): string {
	switch (p.status) {
		case "active":
			return pr_teal("▶")
		case "completed":
			return pr_success("✓")
		case "failed":
			return pr_orange("✗")
		case "skipped":
			return pr_dim("⊘")
		default:
			return pr_dim("○")
	}
}

export function stepBulletChar(status: Step["status"]): string {
	switch (status) {
		case "done":
		case "verified":
			return pr_success("✓")
		case "running":
			return pr_teal("▶")
		case "failed":
			return pr_orange("✗")
		case "skipped":
			return pr_dim("⊘")
		default:
			return pr_dim("○")
	}
}
