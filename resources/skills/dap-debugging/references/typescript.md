# js-debug (TypeScript / JavaScript) Reference

Adapter: `js-debug` · launchType: `pwa-node` · transport: **TCP**
(`node <js-debug>/src/dapDebugServer.js <port>`) · detection: script-path
resolution — `$JS_DEBUG_PATH`, `node_modules/js-debug-adapter/src/dapDebugServer.js`,
then npm global prefix. Project markers `package.json` / `tsconfig.json`.

There is no npm package or standalone binary. Install by extracting
`js-debug-dap-<ver>.tar.gz` from
[github.com/microsoft/vscode-js-debug/releases](https://github.com/microsoft/vscode-js-debug/releases)
and either setting `JS_DEBUG_PATH` or dropping it where the resolver looks.

## Launch config

```json
{ "type": "pwa-node", "request": "launch", "program": "<program>", "sourceMaps": true }
```

`sourceMaps: true` is always injected.

## Nested sessions (startDebugging)

`pwa-node` sends a `startDebugging` reverse-request to spawn the child
debug session. The client opens a second TCP connection to the same server
and routes all debug traffic to it. If child setup fails the session enters
an explicit failed state — no silent fallback to the parent connection.
Nothing special to do; it is transparent.

## Source mapping

- **JavaScript** (`.js`/`.mjs`/`.cjs`): runs directly under plain Node.
  Breakpoints resolve directly.
- **TypeScript** (`.ts`): plain Node fails on type syntax. Options:
  1. Compile first (`tsc`/esbuild) and debug the emitted `.js` — source maps
     link breakpoints back to `.ts` (this is what `sourceMaps: true` is for).
  2. Install `tsx` and launch `node_modules/.bin/tsx` as the program.
  3. Node 22.8+ with `--experimental-strip-types`.
- Breakpoints set in `.ts` source hit **only** when source maps exist.

## Expression syntax (js-debug eval)

Full JavaScript eval: property access, method calls, template literals,
optional chaining — whatever the V8 evaluator accepts in the current frame.

## Productive patterns

- Async boundaries: breakpoints on `await` points where promises resolve
  unexpectedly.
- Error handlers: breakpoints in `catch` blocks where the path diverges.
- `debug_eval` for quick state probes; `debug_locals` for scope dumps.
