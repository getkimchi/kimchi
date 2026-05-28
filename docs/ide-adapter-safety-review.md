# Safety Review — IDE Adapter Extension

## Scope
Review of all changes introduced by `src/extensions/ide-adapter/` and the `cli.ts` wiring.

---

## 🔴 Critical (Must Fix)

### 1. Connection leak prevents reconnection after IDE disconnect
**File:** `index.ts`  
**Lines:** 32–35  
**Issue:** If the WebSocket drops (IDE crash, Wi-Fi blip), `connection` stays non-null. `discoverAndConnect` early-returns because `connection` is still set. The extension never reconnects until the harness restarts.  
**Impact:** User has to restart Kimchi to restore IDE connectivity. Silent failure after one transient error.  
**Fix:** Set `connection = null` inside `IdeConnection.close()`, or wire a heartbeat / `onClose` handler. Already wired in `disconnect()` but `setNotificationHandler` monkey-patches `transport.onmessage` and the inner `IdeConnection` doesn't expose an `onClose` callback.

### 2. Multiple `session_start` events leak timers
**File:** `index.ts`  
**Lines:** 135–144  
**Issue:** If the host fires `session_start` twice (multi-agent session or fast reconnect), a second `setInterval` is created while the first keeps running.  
**Impact:** Duplicate discovery polling, unnecessary CPU and repeated `console.log` spam.  
**Fix:** Guard with `if (pollTimer) clearInterval(pollTimer)` before `setInterval(...)`.

### 3. Global mutable state is shared across sessions
**File:** `at-mentions.ts`  
**Lines:** 6, 9  
**Issue:** `pendingAtMentions` and `latestSelection` are module-level. Two concurrent agents (or sessions) overwrite each other's state.  
**Impact:** At-mentions intended for one session leak into another. Selection state is corrupted.  
**Fix:** Move queue and selection into the extension factory closure so each `ideAdapterExtension(...)` call gets its own state. Refactor `at-mentions.ts` to export a factory instead of global variables.

### 4. Missing `AbortSignal` propagation in tool execute
**File:** `index.ts`  
**Lines:** 67–93  
**Issue:** The `execute` callback receives `signal` but never checks it or forwards it. If the user Ctrl-C's during a long-running IDE tool (e.g. `openDiff`), the tool keeps blocking the IDE.  
**Impact:** Agent hangs, IDE diff viewer stays open, user cannot cancel.  
**Fix:** Pass `signal` to the MCP client if supported, or wrap the call in a `AbortSignal` race. At minimum, check `signal.aborted` before awaiting the call.

---

## 🟡 High (Should Fix)

### 5. No tool de-registration on disconnect
**File:** `index.ts`  
**Issue:** Once a tool is registered via `pi.registerTool()`, there is no `unregisterTool` API in `@earendil-works/pi-coding-agent`. If the IDE reconnects with a different tool set, old tools remain active and can collide on names.  
**Impact:** Stale tool definitions from a dead IDE session persist. Could wrong-name match against new IDE tools.  
**Mitigation:** None until upstream adds unregister support. Track it as a known limitation.

### 6. Unbounded at-mention queue
**File:** `at-mentions.ts`  
**Lines:** 31–32  
**Issue:** `queueAtMention` pushes indefinitely. A malicious or buggy IDE could spam `at_mentioned` and exhaust memory.  
**Impact:** Memory leak, potentially OOM.  
**Fix:** Cap queue at a reasonable limit (e.g., 100) and drop oldest entries.

### 7. `Type.Unsafe` with arbitrary schema
**File:** `index.ts`  
**Lines:** 72–74  
**Issue:** `Type.Unsafe<Record<string, unknown>>(tool.inputSchema)` passes the IDE's schema directly to TypeBox without validation. A malformed Schema (e.g. recursive `$ref`, non-JSON type) could crash TypeBox or the typechecker.  
**Impact:** Crash on tool registration, potentially during every session start.  
**Fix:** Guard with a fast JSON-schema sanity check (e.g., `typeof tool.inputSchema === "object"`).

### 8. No timeout on MCP initialization
**File:** `mcp-client.ts`  
**Lines:** 88–97  
**Issue:** `client.connect(transport)` will hang forever if the WebSocket accepts but never completes the MCP `initialize` handshake. No timeout is set.  
**Impact:** Open socket, leaked promise, blocked discovery.  
**Fix:** Wrap in `Promise.race` with a 15-second timeout.

---

## 🟢 Medium (Nice to Fix)

### 9. No rate limiting on discovery polling
**File:** `index.ts`  
**Lines:** 137–144  
**Issue:** Hard-coded 5-second poll regardless of failure rate. If the IDE is down, every 5 seconds a connection attempt is made (Connection refused traffic).  
**Impact:** Log spam and minor CPU overhead.  
**Fix:** Use exponential back-off or at least a dead-time after a failure.

### 10. `console.log` / `console.warn` in library code
**File:** `index.ts`  
**Issue:** Direct `console.log` calls inside the extension are noisy and bypass the harness's logging infrastructure.  
**Impact:** Pollutes stdout when the harness is running in JSON mode or piping.  
**Fix:** Use `pi` logger if available, or silent by default.

### 11. `lockfile.ts` exception swallowing
**File:** `lockfile.ts`  
**Lines:** 28, 40–42  
**Issue:** `readFileSync` and `readdirSync` errors are silently swallowed. If permissions are wrong, the extension silently does nothing.  
**Impact:** Hard to diagnose why IDE isn't discovered.  
**Fix:** Log at debug level when reads fail.

---

## ✅ Areas Safe / Low Risk

- **cli.ts wiring** — One-line import and array insertion; no side-effects at import time, safe load order.
- **WebSocket transport auth** — `x-secret-key` header is sent over localhost, mitigated by same-machine restriction.
- **lockfile parsing** — Required fields are validated; missing/invalid data returns `null` gracefully.
- **PID liveness check** — `process.kill(pid, 0)` is a best-effort check, acceptable for lockfile filtering.
- **Tool prefix namespacing** — `ide_${tool.name}` prevents collisions with harness-native tools.

---

## Regression Risk Assessment

| File | Risk | Rationale |
|---|---|---|
| `src/cli.ts` | Very Low | Only adds an extension to the array; no behavior change if no lockfiles exist. |
| `src/extensions/ide-adapter/index.ts` | Low-Medium | If `connectToIde` throws synchronously during `session_start`, uncaught error propagates (mitigated by `.catch()` wrapper). |
| `src/extensions/ide-adapter/lockfile.ts` | Very Low | Pure functions, no state, no side-effects beyond `readFileSync` that is try/catched. |
| `src/extensions/ide-adapter/mcp-client.ts` | Medium | Custom WebSocket transport could leak sockets if `close()` is not called. But we call it in `disconnect()`. |
| `src/extensions/ide-adapter/at-mentions.ts` | Low | Global mutable state is the main risk, only affects this extension. |

**Overall:** No regressions in existing harness functionality are expected. The new code is additive and self-contained.
