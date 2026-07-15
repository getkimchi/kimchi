export const INFERENCE_TIMEOUT_ERROR_PREFIX = "inference_timeout"

export interface InferenceTimeoutSettings {
	defaultMs: number
	overrides: Readonly<Record<string, number>>
}

export interface InferenceRequestMetadata {
	model?: string
	provider?: string
	postToolResult: boolean
}

export interface InferenceTimeoutRecord extends InferenceRequestMetadata {
	type: "inference_timeout"
	timeoutMs: number
	durationMs: number
}

export interface InferenceTimeoutFetchOptions {
	fetchImpl: typeof globalThis.fetch
	settings: InferenceTimeoutSettings
	resolveProvider?: (model: string) => string | undefined
	onTimeout?: (record: InferenceTimeoutRecord) => void
	onResponseSettled?: () => void | Promise<unknown>
	now?: () => number
}

export class InferenceTimeoutError extends Error {
	readonly name = "InferenceTimeoutError"
	readonly record: InferenceTimeoutRecord

	constructor(record: InferenceTimeoutRecord) {
		const target = [record.provider, record.model].filter(Boolean).join("/") || "unknown model"
		super(`${INFERENCE_TIMEOUT_ERROR_PREFIX}: ${target} exceeded hard deadline of ${record.timeoutMs}ms`)
		this.record = record
	}
}

export function isModelCompletionFetch(input: RequestInfo | URL): boolean {
	const url = getRequestUrl(input)
	return /\/chat\/completions(?:$|[?#])/.test(url)
}

export function resolveInferenceTimeoutMs(
	settings: InferenceTimeoutSettings,
	metadata: Pick<InferenceRequestMetadata, "provider" | "model">,
): number {
	const { provider, model } = metadata
	if (provider && model) {
		const providerModelOverride = settings.overrides[`${provider}/${model}`]
		if (providerModelOverride !== undefined) return providerModelOverride
	}
	if (model) {
		const modelOverride = settings.overrides[model]
		if (modelOverride !== undefined) return modelOverride
	}
	return settings.defaultMs
}

export function createInferenceTimeoutFetch(options: InferenceTimeoutFetchOptions): typeof globalThis.fetch {
	const now = options.now ?? Date.now
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		if (!isModelCompletionFetch(input)) return options.fetchImpl(input, init)

		const metadata = await readInferenceRequestMetadata(input, init, options.resolveProvider)
		const timeoutMs = resolveInferenceTimeoutMs(options.settings, metadata)
		const startedAt = now()
		const timeoutController = new AbortController()
		const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
		const signal = callerSignal
			? AbortSignal.any([callerSignal, timeoutController.signal])
			: timeoutController.signal
		let timer: ReturnType<typeof setTimeout> | undefined
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
		let settled = false
		let timedOut = false
		let timeoutError: InferenceTimeoutError | undefined

		const settle = () => {
			if (settled) return false
			settled = true
			if (timer !== undefined) clearTimeout(timer)
			void options.onResponseSettled?.()
			return true
		}
		const expire = () => {
			if (settled) return
			timedOut = true
			const record: InferenceTimeoutRecord = {
				type: "inference_timeout",
				...metadata,
				timeoutMs,
				durationMs: Math.max(now() - startedAt, timeoutMs),
			}
			timeoutError = new InferenceTimeoutError(record)
			options.onTimeout?.(record)
			timeoutController.abort(timeoutError)
			if (settle()) {
				streamController?.error(timeoutError)
				void reader?.cancel(timeoutError).catch(() => {})
			}
		}
		timer = setTimeout(expire, timeoutMs)

		let response: Response
		try {
			response = await options.fetchImpl(input, { ...init, signal })
		} catch (error) {
			settle()
			if (timedOut && timeoutError) throw timeoutError
			throw error
		}

		if (!response.body) {
			settle()
			return response
		}

		reader = response.body.getReader()
		const wrappedBody = new ReadableStream<Uint8Array>({
			start(controller) {
				streamController = controller
			},
			async pull(controller) {
				try {
					const result = await reader?.read()
					if (settled) return
					if (!result || result.done) {
						settle()
						controller.close()
						return
					}
					controller.enqueue(result.value)
				} catch (error) {
					if (settled) return
					settle()
					controller.error(timedOut && timeoutError ? timeoutError : error)
				}
			},
			async cancel(reason) {
				settle()
				await reader?.cancel(reason)
			},
		})

		return new Response(wrappedBody, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		})
	}
}

async function readInferenceRequestMetadata(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	resolveProvider: ((model: string) => string | undefined) | undefined,
): Promise<InferenceRequestMetadata> {
	let rawBody: string | undefined
	if (typeof init?.body === "string") {
		rawBody = init.body
	} else if (input instanceof Request) {
		try {
			rawBody = await input.clone().text()
		} catch {
			// The request can still proceed; it just uses the default timeout.
		}
	}

	try {
		const payload = JSON.parse(rawBody ?? "") as { model?: unknown; messages?: unknown }
		const model = typeof payload.model === "string" && payload.model ? payload.model : undefined
		const messages = Array.isArray(payload.messages) ? payload.messages : []
		const lastMessage = messages.at(-1) as { role?: unknown } | undefined
		return {
			model,
			provider: model ? resolveProvider?.(model) : undefined,
			postToolResult: lastMessage?.role === "tool",
		}
	} catch {
		return { postToolResult: false }
	}
}

function getRequestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input
	if (input instanceof URL) return input.href
	return typeof (input as { url?: unknown }).url === "string" ? (input as { url: string }).url : ""
}
