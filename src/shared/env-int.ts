/**
 * Shared env-var integer parsing for extension knobs.
 */

/** Parse a non-negative integer from an env var, falling back when unset/invalid. */
export function parseEnvInt(name: string, fallback: number): number {
	const raw = process.env[name]
	if (raw === undefined || raw === "") return fallback
	const value = Number(raw)
	if (!Number.isFinite(value) || value < 0) return fallback
	return Math.floor(value)
}
