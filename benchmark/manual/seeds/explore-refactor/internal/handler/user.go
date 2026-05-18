package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/example/usermgmt/internal/service"
)

type UserHandler struct {
	svc *service.UserService
}

func NewUserHandler(svc *service.UserService) *UserHandler {
	return &UserHandler{svc: svc}
}

func (h *UserHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /users", h.create)
	mux.HandleFunc("GET /users", h.list)
	mux.HandleFunc("GET /users/{id}", h.getByID)
	mux.HandleFunc("PATCH /users/{id}/role", h.updateRole)
	mux.HandleFunc("PATCH /users/{id}/team", h.assignTeam)
	mux.HandleFunc("DELETE /users/{id}", h.delete)
	mux.HandleFunc("GET /users/search", h.search)
}

func (h *UserHandler) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name   string `json:"name"`
		Email  string `json:"email"`
		Role   string `json:"role"`
		TeamID string `json:"team_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	u, err := h.svc.Create(body.Name, body.Email, body.Role, body.TeamID)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

func (h *UserHandler) list(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.svc.List())
}

func (h *UserHandler) getByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	u, err := h.svc.GetByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (h *UserHandler) updateRole(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Role string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	// BUG: no validation — any arbitrary string accepted as role
	u, err := h.svc.UpdateRole(id, body.Role)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (h *UserHandler) assignTeam(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		TeamID string `json:"team_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	// BUG: no validation — empty team_id accepted without error
	u, err := h.svc.AssignTeam(id, body.TeamID)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (h *UserHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.svc.Delete(id); err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *UserHandler) search(w http.ResponseWriter, r *http.Request) {
	// BUG: no validation or length limit on filter — accepts any string, no max length
	filter := r.URL.Query().Get("q")
	results := h.svc.Search(filter)
	writeJSON(w, http.StatusOK, results)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func extractID(path, prefix string) string {
	return strings.TrimPrefix(path, prefix)
}
