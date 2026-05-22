import { RemoteNetworkError } from "../types.js"

const DEFAULT_READY_TIMEOUT_MS = 90_000
const DEFAULT_POLL_INTERVAL_MS = 1_500
const DEFAULT_PROBE_TIMEOUT_MS = 5_000

export interface WaitForSessionReadyOptions {
	connectToken: string
	wsUrl: string
	signal?: AbortSignal
	timeoutMs?: number
	pollIntervalMs?: number
	probeTimeoutMs?: number
	onTick?: (info: { elapsedMs: number; lastError?: string }) => void
	/** Override fetch for testing. */
	_fetch?: typeof globalThis.fetch
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup()
			resolve()
		}, ms)
		const onAbort = () => {
			cleanup()
			clearTimeout(timer)
			reject(new RemoteNetworkError("Aborted while waiting for session to become ready"))
		}
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort)
		}
		if (signal?.aborted) {
			cleanup()
			clearTimeout(timer)
			reject(new RemoteNetworkError("Aborted while waiting for session to become ready"))
			return
		}
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

/**
 * Probe the `/connect` endpoint once via HTTP. Any response (even 4xx)
 * means the agentgateway is routing traffic to this session — the sandbox
 * is ready. Only network errors / timeouts count as "not ready".
 */
async function probeOnce(opts: {
	url: string
	connectToken: string
	probeTimeoutMs: number
	signal?: AbortSignal
	fetchImpl: typeof globalThis.fetch
}): Promise<{ ready: boolean; error?: string }> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), opts.probeTimeoutMs)

	// Forward parent signal
	const onParentAbort = () => controller.abort()
	opts.signal?.addEventListener("abort", onParentAbort, { once: true })

	try {
		const resp = await opts.fetchImpl(opts.url, {
			method: "GET",
			headers: { Authorization: `Bearer ${opts.connectToken}` },
			signal: controller.signal,
		})
		// Consume body to avoid leaking connections.
		const body = await resp.text().catch(() => "")
		// 5xx means the gateway can't reach the sandbox yet.
		if (resp.status >= 500) {
			return { ready: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` }
		}
		// Any non-5xx response (even 4xx) means the sandbox is routable.
		return { ready: true }
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		return { ready: false, error: msg }
	} finally {
		clearTimeout(timer)
		opts.signal?.removeEventListener("abort", onParentAbort)
	}
}

/**
 * Poll `https://<host>/connect` until the agentgateway responds, which
 * signals that the session is routable and the sandbox is ready for
 * SSH / rsync traffic.
 */
export async function waitForSessionReady(options: WaitForSessionReadyOptions): Promise<void> {
	const signal = options.signal
	const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
	const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
	const fetchImpl = options._fetch ?? globalThis.fetch

	// Convert wss:// to https:// and append /connect
	const httpUrl = `${options.wsUrl
		.replace(/^wss:\/\//, "https://")
		.replace(/^ws:\/\//, "http://")
		.replace(/\/$/, "")}/connect`

	const startedAt = Date.now()
	let lastError: string | undefined

	while (true) {
		if (signal?.aborted) {
			throw new RemoteNetworkError("Aborted while waiting for session to become ready")
		}
		const elapsedMs = Date.now() - startedAt
		if (elapsedMs > timeoutMs) {
			throw new RemoteNetworkError(
				`Session did not become ready within ${Math.round(timeoutMs / 1000)}s (last probe: ${lastError ?? "unknown"})`,
			)
		}

		const probe = await probeOnce({
			url: httpUrl,
			connectToken: options.connectToken,
			probeTimeoutMs,
			signal,
			fetchImpl,
		})

		options.onTick?.({ elapsedMs, lastError: probe.error })

		if (probe.ready) return
		lastError = probe.error

		await sleep(pollIntervalMs, signal)
	}
}
