package service

import (
	"errors"

	"github.com/example/usermgmt/internal/model"
	"github.com/example/usermgmt/internal/repository"
)

type UserService struct {
	users  *repository.UserRepository
	teams  *repository.TeamRepository
	audit  *repository.AuditRepository
}

func NewUserService(users *repository.UserRepository, teams *repository.TeamRepository, audit *repository.AuditRepository) *UserService {
	return &UserService{users: users, teams: teams, audit: audit}
}

func (s *UserService) Create(name, email, role, teamID string) (model.User, error) {
	if name == "" {
		return model.User{}, errors.New("name is required")
	}
	if email == "" {
		return model.User{}, errors.New("email is required")
	}
	if teamID != "" {
		if _, ok := s.teams.GetByID(teamID); !ok {
			return model.User{}, errors.New("team not found")
		}
	}
	u := s.users.Create(model.User{
		Name:   name,
		Email:  email,
		Role:   role,
		TeamID: teamID,
	})
	s.audit.Append(u.ID, "user_created", "")
	return u, nil
}

func (s *UserService) GetByID(id string) (model.User, error) {
	u, ok := s.users.GetByID(id)
	if !ok {
		return model.User{}, errors.New("user not found")
	}
	return u, nil
}

func (s *UserService) List() []model.User {
	return s.users.List()
}

func (s *UserService) Search(filter string) []model.User {
	return s.users.FindByFilter(filter)
}

func (s *UserService) UpdateRole(id, role string) (model.User, error) {
	u, ok := s.users.GetByID(id)
	if !ok {
		return model.User{}, errors.New("user not found")
	}
	u.Role = role
	s.users.Update(u)
	s.audit.Append(id, "role_changed", role)
	return u, nil
}

func (s *UserService) AssignTeam(userID, teamID string) (model.User, error) {
	u, ok := s.users.GetByID(userID)
	if !ok {
		return model.User{}, errors.New("user not found")
	}
	team, ok := s.teams.GetByID(teamID)
	if !ok {
		return model.User{}, errors.New("team not found")
	}
	memberCount := s.users.CountByTeam(teamID)
	if memberCount >= team.MaxMembers {
		return model.User{}, errors.New("team is full")
	}
	u.TeamID = teamID
	s.users.Update(u)
	s.audit.Append(userID, "team_assigned", teamID)
	return u, nil
}

func (s *UserService) Delete(id string) error {
	if !s.users.Delete(id) {
		return errors.New("user not found")
	}
	s.audit.Append(id, "user_deleted", "")
	return nil
}
