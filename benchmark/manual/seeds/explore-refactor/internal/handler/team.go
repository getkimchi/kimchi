package handler

import (
	"encoding/json"
	"net/http"

	"github.com/example/usermgmt/internal/service"
)

type TeamHandler struct {
	svc *service.TeamService
}

func NewTeamHandler(svc *service.TeamService) *TeamHandler {
	return &TeamHandler{svc: svc}
}

func (h *TeamHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /teams", h.create)
	mux.HandleFunc("GET /teams", h.list)
	mux.HandleFunc("GET /teams/{id}", h.getByID)
	mux.HandleFunc("PUT /teams/{id}", h.update)
	mux.HandleFunc("DELETE /teams/{id}", h.delete)
}

func (h *TeamHandler) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		MaxMembers  int    `json:"max_members"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	// BUG: no validation — max_members can be 0 or negative
	t, err := h.svc.Create(body.Name, body.Description, body.MaxMembers)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

func (h *TeamHandler) list(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.svc.List())
}

func (h *TeamHandler) getByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	t, err := h.svc.GetByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (h *TeamHandler) update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		MaxMembers  int    `json:"max_members"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	// BUG: no validation — name can be empty, max_members can be negative
	t, err := h.svc.Update(id, body.Name, body.Description, body.MaxMembers)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (h *TeamHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.svc.Delete(id); err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
