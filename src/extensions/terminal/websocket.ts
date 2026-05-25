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
    const url = "ws://valid-marital-lorikeet-000000-ce70.remote.kimchi.localhost:30000/ssh"
    const connectToken = "eyJhbGciOiAiRWREU0EiLCAidHlwIjogIkpXVCIsICJraWQiOiAiWkFIR0NXcjZIY1BCc1BNTVF6enNyNGFxQjdOMmtCR3dUcGZPdU1wVUEwUSJ9.eyJpc3MiOiAibG9jYWwua2ltY2hpLmRldiIsICJleHAiOiAxNzc5ODA2NjEyLCAic2Vzc2lvbl9pZCI6ICJzLWRlMmYxOWRiLWI0YTUtNGE3MS1iNDUzLTFkOWRkN2IxMzQxNCJ9.GHLPGIYyqMZ05J9M18aeOTnpJP4aTOkT-TaNeva1djPmlt0FdJ9sXGGmGIRFjGTkp3F7y4ItLmLcdh791VubDw"

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
