import { RemoteNetworkError } from "./types.js"

export function normalizeWsUri(raw: string): { wsUrl: string; host: string; port: number } {
	const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i)
	if (schemeMatch && !/^wss?$/i.test(schemeMatch[1])) {
		throw new RemoteNetworkError(`Unexpected protocol "${schemeMatch[1]}:" in server URI: ${raw}`)
	}
	const withScheme = schemeMatch ? raw : `wss://${raw}`
	let url: URL
	try {
		url = new URL(withScheme)
	} catch {
		throw new RemoteNetworkError(`Invalid WebSocket URI from server: ${raw}`)
	}
	if (url.protocol !== "wss:" && url.protocol !== "ws:") {
		throw new RemoteNetworkError(`Unexpected protocol "${url.protocol}" in server URI: ${raw}`)
	}
	const defaultPort = url.protocol === "wss:" ? 443 : 80
	const port = url.port ? Number(url.port) : defaultPort
	if (!Number.isFinite(port) || port <= 0) {
		throw new RemoteNetworkError(`Invalid port in WebSocket URI: ${raw}`)
	}
	const portStr = url.port && Number(url.port) !== defaultPort ? `:${url.port}` : ""
	const pathStr = url.pathname && url.pathname !== "/" ? url.pathname : ""
	return {
		wsUrl: `${url.protocol}//${url.hostname}${portStr}${pathStr}`,
		host: url.hostname,
		port,
	}
}
