export interface ReconnectSupervisorOptions {
	/** Initial backoff sequence in ms. Default [1000, 2000, 4000, 8000, 16000]. */
	delays?: number[]
	/** Max delay (used once the `delays` sequence is exhausted) in ms. Default 30000. */
	maxDelayMs?: number
	/** Max total retry time before giving up in ms. Default 300000 (5 min). */
	maxTotalRetryMs?: number
	/** Close codes that should NOT trigger reconnect. Default [1000, 4001, 4002, 4003]. */
	fatalCodes?: number[]
	/** Called immediately before each backoff wait. */
	onReconnecting?: (attempt: number, delayMs: number) => void
	/** Called when a fatal close code is seen, or the retry budget is exhausted. */
	onFatal?: (code: number, reason: string) => void
	/** Performs the actual reconnect attempt. Invoked after each backoff timer fires. */
	reconnect: () => void
}

const DEFAULT_DELAYS = [1000, 2000, 4000, 8000, 16000]
const DEFAULT_MAX_DELAY_MS = 30_000
const DEFAULT_MAX_TOTAL_RETRY_MS = 300_000
// 1000 = Normal, 4001 = AuthFailed, 4002 = TakenOver, 4003 = SessionFinished.
const DEFAULT_FATAL_CODES = [1000, 4001, 4002, 4003]

/**
 * Decides whether and when to reconnect a transport after a close.
 *
 * Owns timing + budget; the transport owns the actual reconnect step
 * (passed in via `options.reconnect`).
 */
export class ReconnectSupervisor {
	private readonly delays: number[]
	private readonly maxDelayMs: number
	private readonly maxTotalRetryMs: number
	private readonly fatalCodes: Set<number>
	private readonly onReconnecting?: (attempt: number, delayMs: number) => void
	private readonly onFatal?: (code: number, reason: string) => void
	private readonly reconnectFn: () => void

	private cancelled = false
	private retrying = false
	private attempt = 0
	private retryStartTime = 0
	private timer: ReturnType<typeof setTimeout> | null = null

	constructor(options: ReconnectSupervisorOptions) {
		this.delays = options.delays ?? DEFAULT_DELAYS
		this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
		this.maxTotalRetryMs = options.maxTotalRetryMs ?? DEFAULT_MAX_TOTAL_RETRY_MS
		this.fatalCodes = new Set(options.fatalCodes ?? DEFAULT_FATAL_CODES)
		this.onReconnecting = options.onReconnecting
		this.onFatal = options.onFatal
		this.reconnectFn = options.reconnect
	}

	/** Called by the transport whenever its underlying WebSocket closes. */
	handleClose(code: number, reason: string): void {
		if (this.cancelled) return

		if (this.fatalCodes.has(code)) {
			this.retrying = false
			this.onFatal?.(code, reason)
			return
		}

		if (!this.retrying) {
			this.retrying = true
			this.retryStartTime = Date.now()
			this.attempt = 0
		}

		if (Date.now() - this.retryStartTime > this.maxTotalRetryMs) {
			this.retrying = false
			this.onFatal?.(
				code,
				reason
					? `${reason} (giving up after ${Math.round(this.maxTotalRetryMs / 1000)}s)`
					: `gave up reconnecting after ${Math.round(this.maxTotalRetryMs / 1000)}s`,
			)
			return
		}

		const delay = this.attempt < this.delays.length ? (this.delays[this.attempt] as number) : this.maxDelayMs
		const attemptNum = this.attempt + 1
		this.attempt++

		this.onReconnecting?.(attemptNum, delay)
		this.timer = setTimeout(() => {
			this.timer = null
			if (this.cancelled) return
			this.reconnectFn()
		}, delay)
	}

	/** Called by the transport when a reconnect succeeds. Resets backoff state. */
	notifyConnected(): void {
		this.retrying = false
		this.attempt = 0
		this.retryStartTime = 0
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
		}
	}

	/** Cancel any pending reconnect (e.g. user-initiated close). */
	cancel(): void {
		this.cancelled = true
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
		}
	}

	get isRetrying(): boolean {
		return this.retrying
	}
}
