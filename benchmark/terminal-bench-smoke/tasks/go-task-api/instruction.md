Implement a Go REST API for a task management system.

Requirements:
- Use the Go standard library only (no frameworks, no external dependencies).
- Layered architecture: handler → service → repository.
- In-memory repository.
- Endpoints:
  - `POST /tasks` — create a task. Body: `{"title": "...", "description": "..."}`. Response: 201 with the created task as JSON.
  - `GET /tasks` — list all tasks as a JSON array.
  - `GET /tasks/{id}` — get one task; 404 if missing.
  - `PATCH /tasks/{id}` — update status. Body: `{"status": "todo" | "in-progress" | "done"}`. 400 on invalid status, 404 if missing.
  - `DELETE /tasks/{id}` — delete; 204 on success, 404 if missing.
- All responses use proper HTTP status codes and `Content-Type: application/json` (where there is a body).
- Each task has an auto-generated string `id`, a `title`, a `description`, and a `status` (default `"todo"`).
- Unit tests for the service layer using map-based test cases.
- Put all code in directory `/app/task-api/`.
- The `go.mod` module path must be `taskapi` (Go 1.22+).
- Provide a runnable demo at `/app/task-api/cmd/server/main.go` that listens on the port from the `PORT` env var (default `8080`).
