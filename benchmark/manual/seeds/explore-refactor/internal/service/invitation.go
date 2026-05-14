package service

import (
	"errors"
	"time"

	"github.com/example/usermgmt/internal/model"
	"github.com/example/usermgmt/internal/repository"
)

type InvitationService struct {
	invitations *repository.InvitationRepository
	teams       *repository.TeamRepository
	audit       *repository.AuditRepository
}

func NewInvitationService(invitations *repository.InvitationRepository, teams *repository.TeamRepository, audit *repository.AuditRepository) *InvitationService {
	return &InvitationService{invitations: invitations, teams: teams, audit: audit}
}

func (s *InvitationService) Create(email, teamID, role string) (model.Invitation, error) {
	if _, ok := s.teams.GetByID(teamID); !ok {
		return model.Invitation{}, errors.New("team not found")
	}
	inv := s.invitations.Create(model.Invitation{
		Email:     email,
		TeamID:    teamID,
		Role:      role,
		ExpiresAt: time.Now().Add(72 * time.Hour),
	})
	s.audit.Append("system", "invitation_created", inv.ID)
	return inv, nil
}

func (s *InvitationService) ListByTeam(teamID string) []model.Invitation {
	return s.invitations.ListByTeam(teamID)
}

func (s *InvitationService) Revoke(id string) error {
	if !s.invitations.Delete(id) {
		return errors.New("invitation not found")
	}
	s.audit.Append("system", "invitation_revoked", id)
	return nil
}
