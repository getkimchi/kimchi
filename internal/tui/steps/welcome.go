package steps

import (
	"context"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/castai/kimchi/internal/update"
)

type updateCheckMsg struct {
	cli     update.UpdateStatus
	harness update.UpdateStatus
}

// WelcomeStep displays an initial welcome message and checks for updates in the background.
type WelcomeStep struct {
	cli     update.UpdateStatus
	harness update.UpdateStatus
}

func NewWelcomeStep() *WelcomeStep {
	return &WelcomeStep{}
}

func (s *WelcomeStep) Init() tea.Cmd {
	if update.IsUpdateCheckDisabled() {
		return nil
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		msg := updateCheckMsg{}

		var wg sync.WaitGroup
		wg.Add(2)

		go func() {
			defer wg.Done()
			cli, err := update.CheckCLIUpdate(ctx)
			if err != nil {
				return
			}
			msg.cli = *cli
		}()

		go func() {
			defer wg.Done()
			harness, err := update.CheckHarnessUpdate(ctx)
			if err != nil {
				return
			}
			msg.harness = *harness
		}()

		wg.Wait()
		return msg
	}
}

func (s *WelcomeStep) Update(msg tea.Msg) (Step, tea.Cmd) {
	switch msg := msg.(type) {
	case updateCheckMsg:
		s.cli = msg.cli
		s.harness = msg.harness
		return s, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			return s, func() tea.Msg { return AbortMsg{} }
		case "enter", " ":
			return s, func() tea.Msg { return NextStepMsg{} }
		}
	}
	return s, nil
}

func (s *WelcomeStep) View() string {
	view := "Start coding with open-source LLMs now!\n\n" +
		"Kimchi gives you instant access to production-ready open-source\n" +
		"LLMs — " + Styles.Selected.Render("Kimi K2.5") + ", " + Styles.Selected.Render("Nemotron 3 Super FP4") + ", " + Styles.Selected.Render("MiniMax M2.7") + " — via an " + Styles.Selected.Render("OpenAI-compatible") + "\n" +
		"API. No GPUs to provision, no clusters to manage.\n\n" +
		"This wizard will guide you through configuration of your local\n" +
		"coding tools in a few quick steps.\n\n"

	view += Styles.Title.Render("Are you ready?") + "\n\n" +
		Styles.Help.Render("Press Enter to begin")
	return view
}

func (s *WelcomeStep) CLI() update.UpdateStatus     { return s.cli }
func (s *WelcomeStep) Harness() update.UpdateStatus { return s.harness }

func (s *WelcomeStep) Name() string {
	return "Welcome"
}

func (s *WelcomeStep) Info() StepInfo {
	return StepInfo{
		Name:        "Welcome to Kimchi",
		KeyBindings: []KeyBinding{{Key: "↵", Text: "begin"}},
	}
}
