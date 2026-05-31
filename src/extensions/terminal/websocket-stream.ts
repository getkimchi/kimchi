import { Duplex, type DuplexOptions } from "node:stream"
import type WebSocket from "ws"

/**
 * Emits the `'close'` event on a stream.
 *
 * @param {Duplex} stream The stream.
 * @private
 */
function emitClose(stream: Duplex) {
	stream.emit("close")
}

/**
 * Wraps a `WebSocket` in a duplex stream.
 *
 * @param {WebSocket} ws The `WebSocket` to wrap
 * @param {Object} [options] The options for the `Duplex` constructor
 * @return {Duplex} The duplex stream
 * @public
 */
export function createWebSocketStream(ws: WebSocket, options: DuplexOptions) {
	let terminateOnDestroy = true

	const duplex = new Duplex({
		...options,
		autoDestroy: false,
		emitClose: false,
		objectMode: false,
		writableObjectMode: false,
	})

	ws.on("message", function message(msg: any, isBinary: boolean) {
		const data = !isBinary && (duplex as any)._readableState.objectMode ? msg.toString() : msg

		if (!duplex.push(data)) ws.pause()
	})

	ws.once("error", function error(err: any) {
		if (duplex.destroyed) return

		// Prevent `ws.terminate()` from being called by `duplex._destroy()`.
		//
		// - If the `'error'` event is emitted before the `'open'` event, then
		//   `ws.terminate()` is a noop as no socket is assigned.
		// - Otherwise, the error is re-emitted by the listener of the `'error'`
		//   event of the `Receiver` object. The listener already closes the
		//   connection by calling `ws.close()`. This allows a close frame to be
		//   sent to the other peer. If `ws.terminate()` is called right after this,
		//   then the close frame might not be sent.
		terminateOnDestroy = false
		duplex.destroy(err)
	})

	ws.once("close", function close() {
		if (duplex.destroyed) return

		duplex.push(null)
	})

	duplex._destroy = (err, callback) => {
		if (ws.readyState === ws.CLOSED) {
			callback(err)
			process.nextTick(emitClose, duplex)
			return
		}

		let called = false

		ws.once("error", function error(err: any) {
			called = true
			callback(err)
		})

		ws.once("close", function close() {
			if (!called) callback(err)
			process.nextTick(emitClose, duplex)
		})

		if (terminateOnDestroy) ws.terminate()
	}

	duplex._final = (callback) => {
		if (ws.readyState === ws.CONNECTING) {
			ws.once("open", function open() {
				duplex._final(callback)
			})
			return
		}

		// If the value of the `_socket` property is `null` it means that `ws` is a
		// client websocket and the handshake failed. In fact, when this happens, a
		// socket is never assigned to the websocket. Wait for the `'error'` event
		// that will be emitted by the websocket.
		if ((ws as any)._socket === null) return

		if ((ws as any)._socket._writableState.finished) {
			callback()
			if ((duplex as any)._readableState.endEmitted) duplex.destroy()
		} else {
			;(ws as any)._socket.once("finish", function finish() {
				// `duplex` is not destroyed here because the `'end'` event will be
				// emitted on `duplex` after this `'finish'` event. The EOF signaling
				// `null` chunk is, in fact, pushed when the websocket emits `'close'`.
				callback()
			})
			ws.close()
		}
	}

	duplex._read = () => {
		if (ws.isPaused) ws.resume()
	}

	duplex._write = (chunk, encoding, callback) => {
		if (ws.readyState === ws.CONNECTING) {
			ws.once("open", function open() {
				duplex._write(chunk, encoding, callback)
			})
			return
		}

		ws.send(chunk, callback)
	}

	duplex.on("end", () => {
		if (!duplex.destroyed && (duplex as any)._writableState.finished) {
			duplex.destroy()
		}
	})
	duplex.on("error", (err) => {
		if (duplex.destroyed) {
			return
		}

		duplex.destroy()
		if (duplex.listenerCount("error") === 0) {
			// Do not suppress the throwing behavior.
			duplex.emit("error", err)
		}
	})
	return duplex
}
