package service

import (
	"errors"

	"github.com/example/usermgmt/internal/model"
	"github.com/example/usermgmt/internal/repository"
)

type TeamService struct {
	teams *repository.TeamRepository
	audit *repository.AuditRepository
}

func NewTeamService(teams *repository.TeamRepository, audit *repository.AuditRepository) *TeamService {
	return &TeamService{teams: teams, audit: audit}
}

func (s *TeamService) Create(name, description string, maxMembers int) (model.Team, error) {
	if name == "" {
		return model.Team{}, errors.New("name is required")
	}
	t := s.teams.Create(model.Team{
		Name:        name,
		Description: description,
		MaxMembers:  maxMembers,
	})
	s.audit.Append("system", "team_created", t.ID)
	return t, nil
}

func (s *TeamService) GetByID(id string) (model.Team, error) {
	t, ok := s.teams.GetByID(id)
	if !ok {
		return model.Team{}, errors.New("team not found")
	}
	return t, nil
}

func (s *TeamService) List() []model.Team {
	return s.teams.List()
}

func (s *TeamService) Update(id, name, description string, maxMembers int) (model.Team, error) {
	t, ok := s.teams.GetByID(id)
	if !ok {
		return model.Team{}, errors.New("team not found")
	}
	t.Name = name
	t.Description = description
	t.MaxMembers = maxMembers
	s.teams.Update(t)
	return t, nil
}

func (s *TeamService) Delete(id string) error {
	if !s.teams.Delete(id) {
		return errors.New("team not found")
	}
	s.audit.Append("system", "team_deleted", id)
	return nil
}
