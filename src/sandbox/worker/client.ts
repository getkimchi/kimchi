import { openAsBlob } from "node:fs"
import type { WorkspaceCredentials } from "../cloud/types.js"
import { WorkerError } from "./types.js"

export interface WorkerClientOptions {
	fetch?: typeof globalThis.fetch
	timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

export class WorkerClient {
	readonly baseUrl: string
	readonly #token: string
	readonly #fetch: typeof globalThis.fetch
	readonly #timeoutMs: number

	constructor(creds: WorkspaceCredentials, opts?: WorkerClientOptions) {
		this.baseUrl = deriveBaseUrl(creds.wsUrl)
		this.#token = creds.connectToken
		this.#fetch = opts?.fetch ?? globalThis.fetch
		this.#timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	async get<T>(path: string, signal?: AbortSignal): Promise<T> {
		const url = this.#url(path)
		const resp = await fetchWithTimeout(
			url,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.#token}`,
					Accept: "application/json",
				},
			},
			this.#fetch,
			this.#timeoutMs,
			signal,
		)
		await checkResponse(resp, url)
		return (await resp.json()) as T
	}

	async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
		const url = this.#url(path)
		const resp = await fetchWithTimeout(
			url,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#token}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			},
			this.#fetch,
			this.#timeoutMs,
			signal,
		)
		await checkResponse(resp, url)
		return (await resp.json()) as T
	}

	async postMultipart<T>(
		path: string,
		parts: { request: unknown; sessionFile?: string },
		signal?: AbortSignal,
	): Promise<T> {
		const url = this.#url(path)
		const form = new FormData()
		form.append("request", new Blob([JSON.stringify(parts.request)], { type: "application/json" }))
		if (parts.sessionFile !== undefined) {
			const blob = await openAsBlob(parts.sessionFile, { type: "application/octet-stream" })
			form.append("sessionFile", blob, "session.jsonl")
		}
		const resp = await fetchWithTimeout(
			url,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.#token}`,
					Accept: "application/json",
				},
				body: form,
			},
			this.#fetch,
			this.#timeoutMs,
			signal,
		)
		await checkResponse(resp, url)
		return (await resp.json()) as T
	}

	async del(path: string, signal?: AbortSignal): Promise<void> {
		const url = this.#url(path)
		const resp = await fetchWithTimeout(
			url,
			{
				method: "DELETE",
				headers: {
					Authorization: `Bearer ${this.#token}`,
				},
			},
			this.#fetch,
			this.#timeoutMs,
			signal,
		)
		await checkResponse(resp, url)
	}

	#url(path: string): string {
		return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`
	}
}

export function deriveBaseUrl(wsUrl: string): string {
	let httpUrl: string
	if (wsUrl.startsWith("wss://")) {
		httpUrl = `https://${wsUrl.slice("wss://".length)}`
	} else if (wsUrl.startsWith("ws://")) {
		httpUrl = `http://${wsUrl.slice("ws://".length)}`
	} else if (wsUrl.startsWith("https://") || wsUrl.startsWith("http://")) {
		httpUrl = wsUrl
	} else {
		throw new WorkerError(`Unexpected scheme in workspace wsUrl: ${wsUrl}`, 0)
	}
	return httpUrl.replace(/\/+$/, "")
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	fetchImpl: typeof globalThis.fetch,
	ms: number,
	externalSignal?: AbortSignal,
): Promise<Response> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), ms)
	const signal = externalSignal ? AbortSignal.any([ctrl.signal, externalSignal]) : ctrl.signal
	try {
		return await fetchImpl(url, { ...init, signal })
	} finally {
		clearTimeout(timer)
	}
}

async function checkResponse(resp: Response, url: string): Promise<void> {
	if (resp.ok) return
	const text = await resp.text().catch(() => "")
	let body: unknown = text
	if (text) {
		try {
			body = JSON.parse(text)
		} catch {
			// keep text
		}
	}
	throw new WorkerError(`HTTP ${resp.status} from ${url}${text ? `: ${text}` : ""}`, resp.status, body || undefined)
}
