# dlv (Go) Reference

Adapter: `dlv` · launchType: `go` · transport: **TCP** (dlv dap prints
`DAP server listening at:` — never stdio) · detection: `which dlv`,
project marker `go.mod`.

## Launch config

Always merged over the `program` the tool passes:

```json
{ "type": "go", "request": "launch", "mode": "debug", "program": "<program>" }
```

- `mode: "debug"` is required — dlv builds and launches; there is no
  pre-compiled-binary mode here.
- **Cold builds are expected**: the first debug launch compiles the program
  **and the Go stdlib** with `-gcflags="all=-N -l"` (optimization/inlining
  off). Budget 30–60 s; pass a larger `timeout_ms` on the first run.
  Subsequent launches reuse the build cache and are fast.
- If breakpoints don't hit, code may be **inlined** — a user-built binary
  passed through another path needs `go build -gcflags="all=-N -l"`
  explicitly.

## Source mapping

- `program` accepts a package directory (`"./cmd/server"` or `"."`) — dlv
  resolves the `main` package.
- Breakpoint `source` matches the **path as compiled** — relative paths from
  the working directory work; absolute paths work; a `file.go` basename
  works when unambiguous.
- Functions inlined by the compiler have no line table entry — breakpoints
  there never hit (see above).

## Expression syntax (dlv eval)

| Works | Fails |
|---|---|
| Field access: `cache.capacity`, `buf.head` | Method calls: `obj.Method()` (unless experimental `call` prefix) |
| Map access: `m["key"]`, pagination `m[64:]` | Method calls on **unexported** fields: `cache.lru.Len()` |
| Slicing: `s[0]`, `s[10:20]`, `s[64:]` | |
| Builtins: `len(s)`, `cap(s)` | |
| Pointer deref: `*ptr` | |
| Type assertion: `iface.(*main.ConcreteType)` | |
| Package vars: `"some/pkg".VarName` | |
| Goroutine id: `runtime.curg.goid` | |

## Data-structure gotchas

- Arrays/slices/maps show at most **64 elements** — paginate with `s[64:]`.
- Nested expansion in `debug_locals` stops at **2 levels** — follow with
  field access (`a.b.c`).
- Map iteration order is fixed but unsorted.
- Unexported (lowercase) fields *are* readable, just not callable.
