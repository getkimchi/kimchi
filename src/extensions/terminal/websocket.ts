import { createOrUpdateSession, exchangeSessionToken } from "../../modes/teleport/api/sessions.js"
import { verifyApiKey } from "../../modes/teleport/api/keys.js"
import { normalizeWsUri } from "../../modes/teleport/api/uri.js"
import type { AuthenticateResponse } from "../../modes/teleport/api/types.js"
import { WebSocketTransport } from "../../modes/teleport/ws/transport.js"
import { WebSocket } from "ws"
import { Duplex } from "stream"
import { createWebSocketStream } from "./websocket-stream.js"

export async function connectTransport(
  sessionId: string,
  apiKey: string,
): Promise<Duplex> {
  try {
    // const orgId = await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })
    // const { token, expireTime } = await exchangeSessionToken(apiKey, sessionId, { ...options, fetch: fetchImpl })

    // const { wsUrl, host } = normalizeWsUri(session.uri)
    const url = "ws://valid-marital-lorikeet-000000-ce70.remote.kimchi.localhost:30000/connect?mode=pty&name=pty-fun"
    const connectToken = "eyJhbGciOiAiRWREU0EiLCAidHlwIjogIkpXVCIsICJraWQiOiAiWkFIR0NXcjZIY1BCc1BNTVF6enNyNGFxQjdOMmtCR3dUcGZPdU1wVUEwUSJ9.eyJpc3MiOiAibG9jYWwua2ltY2hpLmRldiIsICJleHAiOiAxNzc5ODgwNTY5LCAic2Vzc2lvbl9pZCI6ICJzLWRlMmYxOWRiLWI0YTUtNGE3MS1iNDUzLTFkOWRkN2IxMzQxNCJ9.ssCHo0SrgZluulUG94LVS6FuiLJjB5b5ZzzTr_gQSBtzvST0KjnVjOFlEKVWmRZoXC0BksUPwVVZ-Q73J-RKCQ"

    let ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${connectToken}`,
      }
    })

    return createWebSocketStream(ws, {})
  } catch (err) {
    throw err
  }
}
