package handler

import (
	"net/http"
	"strconv"

	"github.com/example/usermgmt/internal/repository"
)

type AuditHandler struct {
	repo *repository.AuditRepository
}

func NewAuditHandler(repo *repository.AuditRepository) *AuditHandler {
	return &AuditHandler{repo: repo}
}

func (h *AuditHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /audit", h.list)
	mux.HandleFunc("GET /audit/user/{id}", h.listByUser)
}

func (h *AuditHandler) list(w http.ResponseWriter, r *http.Request) {
	// BUG: no validation — offset/limit parsed from query without bounds checking
	// negative values or extremely large limits are accepted
	offsetStr := r.URL.Query().Get("offset")
	limitStr := r.URL.Query().Get("limit")
	offset, _ := strconv.Atoi(offsetStr)
	limit, _ := strconv.Atoi(limitStr)
	if limit == 0 {
		limit = 50
	}
	writeJSON(w, http.StatusOK, h.repo.ListAll(offset, limit))
}

func (h *AuditHandler) listByUser(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	writeJSON(w, http.StatusOK, h.repo.ListByUser(userID))
}
