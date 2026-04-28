package steps

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbletea"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/gsd"
	"github.com/castai/kimchi/internal/tools"
)

type gsdAction int

const (
	gsdActionNone gsdAction = iota
	gsdActionMigrate
	gsdActionInstall
)

type toolGSDStatus struct {
	toolID      tools.ToolID
	toolName    string
	installType gsd.InstallationType
	action      gsdAction
	installed   bool
}

type GSDStep struct {
	selectedTools []tools.ToolID
	scope         config.ConfigScope
	toolStatuses  []toolGSDStatus
	selected      int
	skipReason    string
}

type gsdCheckCompleteMsg struct {
	statuses []toolGSDStatus
	skip     bool
	reason   string
}

func NewGSDStep(selectedTools []tools.ToolID, scope config.ConfigScope) *GSDStep {
	return &GSDStep{
		selectedTools: selectedTools,
		scope:         scope,
		toolStatuses:  nil,
	}
}

func (s *GSDStep) Init() tea.Cmd {
	return s.checkGSDStatus()
}

func (s *GSDStep) checkGSDStatus() tea.Cmd {
	return func() tea.Msg {
		installer := gsd.NewInstaller()

		var statuses []toolGSDStatus
		scopeStr := string(s.scope)

		toolToGSDType := map[tools.ToolID]gsd.InstallationType{
			tools.ToolOpenCode: gsd.InstallationOpenCode,
			tools.ToolCodex:    gsd.InstallationCodex,
		}

		for _, selectedID := range s.selectedTools {
			installType, ok := toolToGSDType[selectedID]
			if !ok {
				continue
			}

			tool, ok := tools.ByID(selectedID)
			if !ok {
				continue
			}

			installed := installer.IsInstalledFor(installType, scopeStr)
			statuses = append(statuses, toolGSDStatus{
				toolID:      selectedID,
				toolName:    tool.Name,
				installType: installType,
				installed:   installed,
				action:      gsdActionNone,
			})
		}

		if len(statuses) == 0 {
			return gsdCheckCompleteMsg{skip: true, reason: "None of the selected tools support GSD"}
		}

		return gsdCheckCompleteMsg{statuses: statuses, skip: false}
	}
}

func (s *GSDStep) GetActions() []gsdAction {
	var actions []gsdAction
	for _, status := range s.toolStatuses {
		if status.action != gsdActionNone {
			actions = append(actions, status.action)
		}
	}
	return actions
}

func (s *GSDStep) GetInstallTypes() []gsd.InstallationType {
	var types []gsd.InstallationType
	for _, status := range s.toolStatuses {
		if status.action == gsdActionInstall {
			types = append(types, status.installType)
		}
	}
	return types
}

func (s *GSDStep) GetMigrateInstallations() []gsd.Installation {
	detector := gsd.NewDetector()
	installations, _ := detector.Detect()

	var result []gsd.Installation
	for _, status := range s.toolStatuses {
		if status.action == gsdActionMigrate {
			for _, inst := range installations {
				if inst.Type == status.installType {
					result = append(result, inst)
				}
			}
		}
	}
	return result
}

func (s *GSDStep) Update(msg tea.Msg) (Step, tea.Cmd) {
	switch m := msg.(type) {
	case gsdCheckCompleteMsg:
		if m.skip {
			s.skipReason = m.reason
			return s, func() tea.Msg { return NextStepMsg{} }
		}
		s.toolStatuses = m.statuses
		return s, nil

	case tea.KeyMsg:
		switch m.String() {
		case "ctrl+c", "q":
			return s, func() tea.Msg { return AbortMsg{} }
		case "esc":
			return s, func() tea.Msg { return PrevStepMsg{} }
		case "up", "k":
			if s.selected > 0 {
				s.selected--
			}
		case "down", "j":
			if s.selected < len(s.toolStatuses)-1 {
				s.selected++
			}
		case " ":
			if s.selected < len(s.toolStatuses) {
				status := &s.toolStatuses[s.selected]
				if status.installed {
					if status.action == gsdActionMigrate {
						status.action = gsdActionNone
					} else {
						status.action = gsdActionMigrate
					}
				} else {
					if status.action == gsdActionInstall {
						status.action = gsdActionNone
					} else {
						status.action = gsdActionInstall
					}
				}
			}
		case "enter":
			return s, func() tea.Msg { return NextStepMsg{} }
		}
	}

	return s, nil
}

func (s *GSDStep) View() string {
	var b strings.Builder

	b.WriteString("Optional: install " + Styles.Selected.Render("GSD (Get Shit Done)") + " multi-agent framework?\n")
	b.WriteString("It orchestrates multiple AI agents — planner, researcher, executor, verifier —\n")
	b.WriteString("each using the model best suited to the task.\n\n")

	// Check if GSD2 tool is selected and show warning
	if s.hasGSD2Selected() {
		b.WriteString(Styles.Warning.Render("⚠ Warning: "))
		b.WriteString("This will overwrite your existing GSD configuration files:\n")
		b.WriteString(Styles.Desc.Render("  • ~/.gsd/preferences.md\n"))
		b.WriteString(Styles.Desc.Render("  • ~/.gsd/agent/models.json\n\n"))
	}

	b.WriteString("Select the tools you want GSD for, or just press enter to skip.\n\n")

	for i, status := range s.toolStatuses {
		cursor := "  "
		if s.selected == i {
			cursor = Styles.Cursor.Render("► ")
		}

		checkbox := "[ ]"
		if status.action != gsdActionNone {
			checkbox = Styles.Selected.Render("[✓]")
		}

		var actionText string
		if status.action == gsdActionMigrate {
			actionText = Styles.Success.Render(" migrate to Kimchi models")
		} else if status.action == gsdActionInstall {
			actionText = Styles.Success.Render(" install GSD agents")
		} else if status.installed {
			actionText = Styles.Desc.Render(" installed (no changes)")
		} else {
			actionText = Styles.Desc.Render(" not installed")
		}

		line := fmt.Sprintf("%s %s %-12s %s", cursor, checkbox, status.toolName, actionText)
		b.WriteString(line)
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(Styles.Help.Render("Press space to toggle, enter to continue"))

	return b.String()
}

// hasGSD2Selected checks if GSD2 tool is in the initially selected tools list.
func (s *GSDStep) hasGSD2Selected() bool {
	for _, t := range s.selectedTools {
		if t == tools.ToolGSD2 {
			return true
		}
	}
	return false
}

func (s *GSDStep) Name() string {
	return "GSD multi-agent setup"
}

func (s *GSDStep) Info() StepInfo {
	return StepInfo{
		Name: "GSD multi-agent setup",
		KeyBindings: []KeyBinding{
			BindingsNavigate,
			BindingsSelect,
			BindingsConfirm,
			BindingsBack,
			BindingsQuit,
		},
	}
}
