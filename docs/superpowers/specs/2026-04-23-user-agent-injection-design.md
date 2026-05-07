# User-Agent Injection via undici Dispatcher

## Context

The LLM provider config in `src/models.ts` contains a hardcoded `"User-Agent": "kimchi/0.0.1"` header. This is wrong for two reasons: the version is static and will never reflect actual releases, and the header is model-config-visible rather than being a transparent transport concern. The goal is to inject the correct versioned User-Agent on every outgoing HTTP request, opaquely, using the git-tag-derived version.

The release pipeline (`release.yml`) already runs `scripts/set-version.js` to patch `package.json` with the git tag before building the binary. `getVersion()` in `src/utils.ts` reads that value at runtime. So the version source is already correct — we just need to wire it up at the right layer.

## Design

### Version source

Use the existing `getVersion()` from `src/utils.ts`. It reads `package.json` once and caches the result. At release time this will be the git tag version (e.g. `0.0.8`). In dev it will be whatever `package.json` says.

### Injection point

In `src/cli.ts`, where the global undici dispatcher is configured, compose the `EnvHttpProxyAgent` with an interceptor that sets `user-agent` on every outgoing request:

```ts
import { getVersion } from "./utils.js"

const userAgent = `kimchi/${getVersion()}`
const agent = new EnvHttpProxyAgent()
setGlobalDispatcher(
    agent.compose((dispatch) => (opts, handler) => {
        const headers = new Headers(opts.headers as HeadersInit)
        headers.set("user-agent", userAgent)
        return dispatch({ ...opts, headers: Object.fromEntries(headers) }, handler)
    })
)
```

This covers every `fetch()` call made by the process — LLM API calls, model listing, web fetch, web search — without any call-site changes.

### Cleanup

- Remove `headers: { "User-Agent": "kimchi/0.0.1" }` from `buildModelsConfig()` in `src/models.ts`
- Remove hardcoded `"User-Agent": "kimchi-web-fetch/0.1"` from `src/extensions/web-fetch/page-fetcher.ts` — it will be covered by the global interceptor

## Files

- `src/cli.ts` — add interceptor wrapping `EnvHttpProxyAgent`
- `src/models.ts` — remove `headers` field from provider config
- `src/extensions/web-fetch/page-fetcher.ts` — remove hardcoded User-Agent header

## Verification

1. Run `pnpm run build` — should compile clean
2. Run `pnpm run check` — lint + type check pass
3. Run `pnpm run test` — tests pass
4. Manually: run the binary, make a request, verify `User-Agent` header is present in server logs or via a proxy (e.g. `mitmproxy`)
