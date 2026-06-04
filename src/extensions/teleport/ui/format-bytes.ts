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
