// WebSocket SSH proxy — bridges an SSH connection over a WebSocket tunnel.
//
// Hardened port of .claude/proxy.js. Invoked via ssh ProxyCommand:
//   AUTH_TOKEN=<token> ssh -o 'ProxyCommand=node teleport-proxy.js %h %p' <user>@<host>
//
// Scheme selection:
//   - Default: wss://
//   - ws:// is used when the host is loopback (localhost / 127.0.0.1 / ::1).
//   - KIMCHI_TELEPORT_INSECURE_WS=1 forces ws:// for any host (dev override).
//
// Other env knobs:
//   - AUTH_TOKEN: sent as `Authorization: Bearer <token>` on the WS upgrade.
//   - KIMCHI_TELEPORT_WS_PATH: path component, default "/ssh".
//   - KIMCHI_TELEPORT_IDLE_MS: idle timeout in ms, default 300000 (5 minutes).
//
// Exit codes:
//   0 — clean close (peer closed or stdin EOF).
//   1 — WebSocket error or non-normal close.
//   2 — idle timeout fired.

const [host, port] = process.argv.slice(2)
if (!host || !port) {
	process.stderr.write("usage: node teleport-proxy.js <host> <port>\n")
	process.exit(1)
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])
const isLoopback = LOOPBACK_HOSTS.has(host)
const insecureAllowed = process.env.KIMCHI_TELEPORT_INSECURE_WS === "1"
const scheme = isLoopback || insecureAllowed ? "ws" : "wss"
const path = process.env.KIMCHI_TELEPORT_WS_PATH || "/ssh"
const token = process.env.AUTH_TOKEN || ""
const authState = token ? "present" : "missing"
const sep = path.includes("?") ? "&" : "?"
const tokenQs = token ? `${sep}token=${encodeURIComponent(token)}` : ""
const url = `${scheme}://${host}:${port}${path}${tokenQs}`

const headers = {}
if (token) headers.Authorization = `Bearer ${token}`

const idleMs = Number(process.env.KIMCHI_TELEPORT_IDLE_MS) || 5 * 60 * 1000
let idleTimer
function resetIdle() {
	if (idleTimer) clearTimeout(idleTimer)
	idleTimer = setTimeout(() => {
		process.stderr.write(`teleport-proxy: idle timeout after ${idleMs}ms (url=${url} auth=${authState})\n`)
		try {
			ws.close(1001)
		} catch {}
		process.exit(2)
	}, idleMs)
}

const ws = new WebSocket(url, { headers })
ws.binaryType = "arraybuffer"

ws.addEventListener("open", () => {
	resetIdle()
	process.stdin.on("data", (chunk) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(chunk)
	})
	process.stdin.on("end", () => {
		try {
			ws.close(1000)
		} catch {}
	})
})

ws.addEventListener("message", ({ data }) => {
	resetIdle()
	if (data instanceof ArrayBuffer) process.stdout.write(Buffer.from(data))
	else if (typeof data === "string") process.stdout.write(data)
})

ws.addEventListener("close", (event) => {
	if (idleTimer) clearTimeout(idleTimer)
	const code = event?.code ?? 0
	if (code === 1000 || code === 1001) process.exit(0)
	process.stderr.write(
		`teleport-proxy: WebSocket closed code=${code} reason=${event?.reason || "(none)"} url=${url} auth=${authState}\n`,
	)
	process.exit(1)
})

ws.addEventListener("error", (event) => {
	const msg = event?.message || String(event)
	process.stderr.write(`teleport-proxy: WebSocket error: ${msg} url=${url} auth=${authState}\n`)
})

function shutdown(signal) {
	process.stderr.write(`teleport-proxy: received ${signal}, closing WS\n`)
	if (idleTimer) clearTimeout(idleTimer)
	try {
		ws.close(1000)
	} catch {}
	// Give the close handshake a moment, but don't hang forever.
	setTimeout(() => process.exit(0), 500).unref()
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
