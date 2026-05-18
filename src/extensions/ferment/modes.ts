/**
 * Legacy mode predicates.
 *
 * Persisted ferment mode is no longer behavioral. Keep these helpers as inert
 * compatibility wrappers until the old mode surface is fully retired.
 */

import type { Ferment } from "../../ferment/types.js"
import { getContinuationPolicy } from "./state.js"

export function isPlanFerment(f: Ferment | undefined | null): boolean {
	return !!f && getContinuationPolicy() === "manual"
}

export function isExecFerment(f: Ferment | undefined | null): boolean {
	return !!f && getContinuationPolicy() === "automated"
}

export function isAutoFerment(f: Ferment | undefined | null): boolean {
	return !!f && getContinuationPolicy() === "automated"
}

export function isPlanMode(): boolean {
	return getContinuationPolicy() === "manual"
}

export function isExecMode(): boolean {
	return getContinuationPolicy() === "automated"
}

export function isAutoMode(): boolean {
	return getContinuationPolicy() === "automated"
}
