export function requestWithAbort<T>(request: Promise<T>, signal: AbortSignal | undefined): Promise<T | "aborted"> {
	if (!signal) return request
	if (signal.aborted) return Promise.resolve("aborted")

	return new Promise((resolve, reject) => {
		const onAbort = () => resolve("aborted")
		signal.addEventListener("abort", onAbort, { once: true })
		request.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
	})
}
