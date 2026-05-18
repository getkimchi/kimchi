package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/example/usermgmt/internal/handler"
	"github.com/example/usermgmt/internal/repository"
	"github.com/example/usermgmt/internal/service"
)

func main() {
	userRepo := repository.NewUserRepository()
	teamRepo := repository.NewTeamRepository()
	invRepo := repository.NewInvitationRepository()
	auditRepo := repository.NewAuditRepository()

	userSvc := service.NewUserService(userRepo, teamRepo, auditRepo)
	teamSvc := service.NewTeamService(teamRepo, auditRepo)
	invSvc := service.NewInvitationService(invRepo, teamRepo, auditRepo)

	mux := http.NewServeMux()
	handler.NewUserHandler(userSvc).Register(mux)
	handler.NewTeamHandler(teamSvc).Register(mux)
	handler.NewInvitationHandler(invSvc).Register(mux)
	handler.NewAuditHandler(auditRepo).Register(mux)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	addr := fmt.Sprintf(":%s", port)
	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
