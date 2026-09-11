/**
 * Format a byte count in decimal SI units (KB = 1000 B, MB = 1_000_000 B, …).
 * Decimal so the rendered units agree with the workspace-size thresholds
 * (SIZE_WARN_BYTES / SIZE_REFUSE_BYTES) and the warn/refuse messages in the
 * teleport command, which are all defined in decimal. Use IEC suffixes
 * (KiB/MiB/GiB) if you ever need binary scaling.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`
	if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`
	if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
	return `${(bytes / 1_000_000_000).toFixed(2)} GB`
}

/** Binary-SI units, smallest to largest, as used by Kubernetes quantities. */
const BINARY_UNITS: [suffix: string, bytes: number][] = [
	["Ki", 1024],
	["Mi", 1024 ** 2],
	["Gi", 1024 ** 3],
	["Ti", 1024 ** 4],
	["Pi", 1024 ** 5],
	["Ei", 1024 ** 6],
]

/**
 * Format a byte count in Kubernetes convention: the largest binary unit
 * (Ki…Ei) that divides the value exactly, integers only (1.5 Gi shows as
 * "1536Mi", matching kubectl); a value that is not a whole multiple of Ki
 * renders as plain bytes. Mirrors the quantity strings the control plane
 * round-trips ("512Mi", "10Gi").
 */
export function formatK8sBytes(bytes: number): string {
	for (let i = BINARY_UNITS.length - 1; i >= 0; i--) {
		const [suffix, size] = BINARY_UNITS[i]
		if (bytes >= size && bytes % size === 0) return `${bytes / size}${suffix}`
	}
	return `${bytes}`
}

/**
 * Format a current/max byte pair in one shared unit so the two sides are
 * directly comparable: the unit is the largest binary unit that divides max
 * exactly (the largest that fits when max is not a whole multiple; plain
 * bytes below 1Ki). The current side may render with up to two decimals
 * ("1.5Gi/120Gi") — both sides stay valid Kubernetes quantities.
 */
export function formatK8sBytesPair(current: number, max: number): string {
	let suffix = ""
	let size = 1
	for (let i = BINARY_UNITS.length - 1; i >= 0; i--) {
		const [s, b] = BINARY_UNITS[i]
		if (max >= b && max % b === 0) {
			suffix = s
			size = b
			break
		}
	}
	if (suffix === "") {
		for (let i = BINARY_UNITS.length - 1; i >= 0; i--) {
			if (max >= BINARY_UNITS[i][1]) {
				suffix = BINARY_UNITS[i][0]
				size = BINARY_UNITS[i][1]
				break
			}
		}
	}
	return `${mantissa(current / size)}${suffix}/${mantissa(max / size)}${suffix}`
}

/** Integer mantissas print bare; others trim to at most two decimals. */
function mantissa(scaled: number): string {
	if (Number.isInteger(scaled)) return String(scaled)
	return String(Number(scaled.toFixed(2)))
}

/**
 * Format a millicore count in Kubernetes convention: kubectl (describe
 * node/pod, top) keeps the millicore "m" suffix even above one core
 * (1500 → "1500m", not "1.5").
 */
export function formatMillicores(millicores: number): string {
	return `${millicores}m`
}
