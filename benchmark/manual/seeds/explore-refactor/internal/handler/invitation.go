package handler

import (
	"encoding/json"
	"net/http"

	"github.com/example/usermgmt/internal/service"
)

type InvitationHandler struct {
	svc *service.InvitationService
}

func NewInvitationHandler(svc *service.InvitationService) *InvitationHandler {
	return &InvitationHandler{svc: svc}
}

func (h *InvitationHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /invitations", h.create)
	mux.HandleFunc("GET /invitations", h.listByTeam)
	mux.HandleFunc("DELETE /invitations/{id}", h.revoke)
}

func (h *InvitationHandler) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email  string `json:"email"`
		TeamID string `json:"team_id"`
		Role   string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	// BUG: no validation — email can be empty or malformed, role is arbitrary
	inv, err := h.svc.Create(body.Email, body.TeamID, body.Role)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, inv)
}

func (h *InvitationHandler) listByTeam(w http.ResponseWriter, r *http.Request) {
	// BUG: no validation — empty team_id returns empty list without error
	teamID := r.URL.Query().Get("team_id")
	writeJSON(w, http.StatusOK, h.svc.ListByTeam(teamID))
}

func (h *InvitationHandler) revoke(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := h.svc.Revoke(id); err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
