interface PullRequestObservation {
	provider?: unknown
	host?: unknown
	id?: unknown
	url?: unknown
	checkedAt?: unknown
}

export function pullRequestKey(pr: PullRequestObservation): string {
	const id = typeof pr.id === "string" && typeof pr.host === "string" ? pr.id : pr.url
	return JSON.stringify([pr.provider ?? "github", pr.host, id])
}

/** Upgrade URL-only records, and keep one provider identity across repository renames. */
export function mergePullRequestLinks<T extends PullRequestObservation>(...groups: T[][]): T[] {
	const merged = new Map<string, T>()
	const urls = new Map<string, string>()
	for (const group of groups)
		for (const item of group) {
			if (typeof item.url !== "string" || typeof item.checkedAt !== "string") continue
			const key = pullRequestKey(item)
			const sameUrl = merged.get(urls.get(item.url) ?? key)
			const previous = merged.get(key) ?? (!sameUrl?.id || !item.id ? sameUrl : undefined)
			const update =
				!previous ||
				typeof previous.checkedAt !== "string" ||
				Date.parse(item.checkedAt) >= Date.parse(previous.checkedAt)
					? { ...previous, ...item }
					: { ...item, ...previous }
			const updatedKey = pullRequestKey(update)
			if (previous) {
				if (pullRequestKey(previous) !== updatedKey) merged.delete(pullRequestKey(previous))
				if (typeof previous.url === "string") urls.set(previous.url, updatedKey)
			}
			merged.set(updatedKey, update)
			urls.set(item.url, updatedKey)
		}
	return [...merged.values()]
}
