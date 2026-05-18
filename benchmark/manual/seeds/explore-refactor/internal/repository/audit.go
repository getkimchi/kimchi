package repository

import (
	"fmt"
	"sync"
	"time"

	"github.com/example/usermgmt/internal/model"
)

type AuditRepository struct {
	mu      sync.RWMutex
	entries []model.AuditEntry
	seq     int
}

func NewAuditRepository() *AuditRepository {
	return &AuditRepository{}
}

func (r *AuditRepository) Append(userID, action, detail string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	r.entries = append(r.entries, model.AuditEntry{
		ID:        fmt.Sprintf("a-%d", r.seq),
		UserID:    userID,
		Action:    action,
		Detail:    detail,
		CreatedAt: time.Now(),
	})
}

func (r *AuditRepository) ListByUser(userID string) []model.AuditEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]model.AuditEntry, 0)
	for _, e := range r.entries {
		if e.UserID == userID {
			out = append(out, e)
		}
	}
	return out
}

func (r *AuditRepository) ListAll(offset, limit int) []model.AuditEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if offset >= len(r.entries) {
		return nil
	}
	end := offset + limit
	if end > len(r.entries) {
		end = len(r.entries)
	}
	return r.entries[offset:end]
}
