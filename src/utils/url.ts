/** A URL with an allowed protocol and no credentials, query or fragment; otherwise undefined. */
export function plainURL(value: unknown, protocols: readonly string[] = ["https:"]): URL | undefined {
	if (typeof value !== "string") return undefined
	try {
		const url = new URL(value)
		if (protocols.includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return url
	} catch {}
	return undefined
}
