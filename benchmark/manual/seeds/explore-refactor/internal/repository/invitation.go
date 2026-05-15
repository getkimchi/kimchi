package repository

import (
	"fmt"
	"sync"
	"time"

	"github.com/example/usermgmt/internal/model"
)

type InvitationRepository struct {
	mu          sync.RWMutex
	invitations map[string]model.Invitation
	seq         int
}

func NewInvitationRepository() *InvitationRepository {
	return &InvitationRepository{invitations: make(map[string]model.Invitation)}
}

func (r *InvitationRepository) Create(inv model.Invitation) model.Invitation {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	inv.ID = fmt.Sprintf("inv-%d", r.seq)
	inv.CreatedAt = time.Now()
	r.invitations[inv.ID] = inv
	return inv
}

func (r *InvitationRepository) GetByID(id string) (model.Invitation, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	inv, ok := r.invitations[id]
	return inv, ok
}

func (r *InvitationRepository) ListByTeam(teamID string) []model.Invitation {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]model.Invitation, 0)
	for _, inv := range r.invitations {
		if inv.TeamID == teamID {
			out = append(out, inv)
		}
	}
	return out
}

func (r *InvitationRepository) Delete(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.invitations[id]; !ok {
		return false
	}
	delete(r.invitations, id)
	return true
}
