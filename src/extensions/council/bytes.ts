export function truncateUtf8(value: string, maximumBytes: number): string {
	if (maximumBytes <= 0) return ""
	const bytes = Buffer.from(value)
	if (bytes.length <= maximumBytes) return value
	let end = maximumBytes
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
	return bytes.subarray(0, end).toString("utf8")
}
