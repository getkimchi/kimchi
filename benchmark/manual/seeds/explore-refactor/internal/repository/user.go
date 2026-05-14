package repository

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/example/usermgmt/internal/model"
)

type UserRepository struct {
	mu    sync.RWMutex
	users map[string]model.User
	seq   int
}

func NewUserRepository() *UserRepository {
	return &UserRepository{users: make(map[string]model.User)}
}

func (r *UserRepository) Create(u model.User) model.User {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	u.ID = fmt.Sprintf("u-%d", r.seq)
	u.CreatedAt = time.Now()
	r.users[u.ID] = u
	return u
}

func (r *UserRepository) GetByID(id string) (model.User, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	u, ok := r.users[id]
	return u, ok
}

func (r *UserRepository) List() []model.User {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]model.User, 0, len(r.users))
	for _, u := range r.users {
		out = append(out, u)
	}
	return out
}

func (r *UserRepository) FindByFilter(filter string) []model.User {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]model.User, 0)
	for _, u := range r.users {
		if strings.Contains(u.Name, filter) || strings.Contains(u.Email, filter) {
			out = append(out, u)
		}
	}
	return out
}

func (r *UserRepository) Update(u model.User) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.users[u.ID]; !ok {
		return false
	}
	r.users[u.ID] = u
	return true
}

func (r *UserRepository) Delete(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.users[id]; !ok {
		return false
	}
	delete(r.users, id)
	return true
}

func (r *UserRepository) CountByTeam(teamID string) int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	count := 0
	for _, u := range r.users {
		if u.TeamID == teamID {
			count++
		}
	}
	return count
}
