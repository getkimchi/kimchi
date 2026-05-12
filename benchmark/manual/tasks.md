# Task Definitions

Used across all sessions as consistent benchmarks.

---

## Task 1 — Simple coding: Go HTTP Rate Limiter Middleware

**Prompt:**
```
Implement a Go HTTP middleware that rate-limits requests per client IP using a token bucket algorithm.
Requirements:
- Each IP gets 10 requests per second
- Respond with HTTP 429 when limit is exceeded
- Thread-safe implementation
- Put the code in directory: rate-limiter/
- Include a README.md explaining usage
```

**Expected:** single subagent, light/standard model, <5 min, tests included, no external deps.

**Baseline (Claude):** token bucket via sync.Map + per-bucket mutex, cleanup goroutine, net.SplitHostPort for IP, map-based tests, no comments.

---

## Task 2 — Complex coding: Go REST API Task Management

**Prompt:**
```
Implement a Go REST API for a task management system.
Requirements:
- Use standard library only (no frameworks, no external dependencies)
- Layered architecture: handler -> service -> repository
- In-memory repository
- Endpoints: POST /tasks (create, fields: title+description), GET /tasks (list all), GET /tasks/{id} (get by id), PATCH /tasks/{id} (update status: todo/in-progress/done), DELETE /tasks/{id} (delete)
- Proper HTTP status codes and JSON responses
- Unit tests for the service layer using map-based test cases
- Put all code in directory: task-api/
```

**Expected:** plan phase (heavy model) + implementation phase (standard model), <10 min, clean layer separation, map-based tests, stdlib only.

**Baseline (Claude):** model.go, repository interface + in-memory impl, service with interface, handler with manual routing, atomic counter for IDs, map-based service tests, no external deps, no comments.

---

## Task 3 — Research query: Most popular Go HTTP router libraries

**Prompt:**
```
What are the most popular third-party HTTP router libraries for Go?
List the top 3 with: GitHub stars (approximate), key differentiators, and a one-line example of defining a route with a path parameter.
```

**Expected:** orchestrator answers directly without spawning subagents (it has web-search available), fast (<1 min), concise response, no code written.

**Baseline (Claude):**
1. **gorilla/mux** (~21k stars) — feature-rich, regex routes, middleware. `r.HandleFunc("/users/{id}", handler)`
2. **go-chi/chi** (~18k stars) — lightweight, idiomatic, composable middleware. `r.Get("/users/{id}", handler)`
3. **julienschmidt/httprouter** (~16k stars) — minimal, fastest, explicit method routing. `router.GET("/users/:id", handler)`

---

## Task 4 — Mega coding: Go Concurrent Build System

**Not included in run-all.sh** — run separately via `run-mega-<model>.sh`.

**Prompt:**
```
Implement a Go CLI application that acts as a concurrent build system, similar to a simplified Make.
This is a multi-layer project — start with a plan before writing any code.
Requirements:
- Use standard library only (no frameworks, no external dependencies).
- Parse a declarative build file (buildfile.txt) with this format:
    target: dep1 dep2
        command1
        command2
  Indented lines under a target are shell commands. Dependencies are space-separated after the colon.
- Resolve the full dependency graph using topological sort. Detect and report cycles with a clear error message listing the cycle path.
- Execute independent targets concurrently using a worker pool. Targets whose dependencies are all satisfied should start immediately.
- Stream command output per target with prefixed labels, e.g. "[compile] go build ./...".
- Graceful shutdown on SIGINT: finish in-progress targets, skip pending ones, print a summary of what completed and what was skipped.
- CLI flags: -f <file> (build file path, default: buildfile.txt), -j <N> (max parallel workers, default: number of CPUs), -target <name> (build a specific target and its transitive deps only, default: build all root targets).
- Fail fast: on the first target error, cancel pending targets and report which target and command failed.
- Layered architecture: separate packages for parsing, graph resolution, execution engine, and CLI.
- Unit tests for: build file parsing (valid and malformed input), dependency resolution (diamond deps, cycle detection, single target extraction), and execution ordering (verify concurrency-safe ordering). Use map-based test cases.
- Put all code in directory: $DIR/buildtool/
```

**Expected:** plan phase (heavy model) + multiple implementation subagents, 3–6 subagents, <15 min, clean package separation, comprehensive tests, stdlib only.

**Baseline (Claude):** parser package (line-by-line state machine), graph package (Kahn's algorithm for topo sort, DFS for cycle detection), engine package (worker pool with channels, context cancellation, SIGINT trap), cli package (flag parsing), main.go wiring. Map-based tests covering: empty buildfile, single target, diamond dependencies, direct cycle, indirect cycle, malformed indentation, partial-target build, fail-fast propagation.

---
