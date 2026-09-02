export const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
export const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s)

export function requestWithAbort<T>(request: Promise<T>, signal: AbortSignal | undefined): Promise<T | "aborted"> {
	if (!signal) return request
	if (signal.aborted) return Promise.resolve("aborted")

	return new Promise((resolve, reject) => {
		const onAbort = () => resolve("aborted")
		signal.addEventListener("abort", onAbort, { once: true })
		request.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
	})
}
