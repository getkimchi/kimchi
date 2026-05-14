package repository

import (
	"fmt"
	"sync"
	"time"

	"github.com/example/usermgmt/internal/model"
)

type TeamRepository struct {
	mu    sync.RWMutex
	teams map[string]model.Team
	seq   int
}

func NewTeamRepository() *TeamRepository {
	return &TeamRepository{teams: make(map[string]model.Team)}
}

func (r *TeamRepository) Create(t model.Team) model.Team {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	t.ID = fmt.Sprintf("t-%d", r.seq)
	t.CreatedAt = time.Now()
	r.teams[t.ID] = t
	return t
}

func (r *TeamRepository) GetByID(id string) (model.Team, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.teams[id]
	return t, ok
}

func (r *TeamRepository) List() []model.Team {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]model.Team, 0, len(r.teams))
	for _, t := range r.teams {
		out = append(out, t)
	}
	return out
}

func (r *TeamRepository) Update(t model.Team) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.teams[t.ID]; !ok {
		return false
	}
	r.teams[t.ID] = t
	return true
}

func (r *TeamRepository) Delete(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.teams[id]; !ok {
		return false
	}
	delete(r.teams, id)
	return true
}
