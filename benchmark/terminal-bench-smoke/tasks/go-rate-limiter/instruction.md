Implement a Go HTTP middleware that rate-limits requests per client IP using a token bucket algorithm.

Requirements:
- Each IP gets 10 requests per second (refill rate).
- Respond with HTTP 429 when the limit is exceeded.
- Thread-safe implementation.
- Standard library only (no external dependencies).
- Put all code in directory `/app/rate-limiter/`.
- The package must be named `ratelimiter` and live at `/app/rate-limiter/ratelimiter.go`.
- Export a function with the exact signature:
    `func Middleware(next http.Handler) http.Handler`
- Provide a `go.mod` for module path `ratelimiter` (Go 1.22 or newer).
- Provide a runnable demo at `/app/rate-limiter/cmd/server/main.go` that wraps a handler returning HTTP 200 "ok" on `GET /` and listens on the port from the `PORT` env var (default `8080`).
- The middleware MUST identify the client IP from the `X-Forwarded-For` header when present (using the first comma-separated value), falling back to `r.RemoteAddr` otherwise.
- Include a `README.md` in `/app/rate-limiter/` explaining usage.
- Include unit tests using map-based test cases.
