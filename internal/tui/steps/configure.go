package steps

import (
	"fmt"
	"strings"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/tools"
)

type ConfigureParams struct {
	ToolIDs        []tools.ToolID
	Scope          config.ConfigScope
	TelemetryOptIn bool
	APIKey         string
	Mode           config.ConfigMode
}

type toolStatus struct {
	tool    tools.Tool
	status  string
	err     error
	writing bool
}

type spinTickMsg struct{}

type ConfigureStep struct {
	toolIDs          []tools.ToolID
	scope            config.ConfigScope
	telemetryOptIn   bool
	apiKey           string
	mode             config.ConfigMode
	shellProfilePath string
	shellProfileErr  error
	statuses         []toolStatus
	done             bool
	startOnce        sync.Once
	spinFrame        int
}

type writeCompleteMsg struct {
	index  int
	status string
	err    error
}

type startWriteMsg struct{}

func NewConfigureStep(params ConfigureParams) *ConfigureStep {
	return &ConfigureStep{
		toolIDs:        params.ToolIDs,
		scope:          params.Scope,
		telemetryOptIn: params.TelemetryOptIn,
		apiKey:         params.APIKey,
		mode:           params.Mode,
		statuses:       make([]toolStatus, len(params.ToolIDs)),
	}
}

func (s *ConfigureStep) Init() tea.Cmd {
	return tea.Tick(50*time.Millisecond, func(t time.Time) tea.Msg {
		return startWriteMsg{}
	})
}

func (s *ConfigureStep) Update(msg tea.Msg) (Step, tea.Cmd) {
	switch m := msg.(type) {
	case startWriteMsg:
		s.startOnce.Do(func() {
			for i, toolID := range s.toolIDs {
				tool, ok := tools.ByID(toolID)
				if !ok {
					s.statuses[i] = toolStatus{tool: tool, status: "unknown tool", err: fmt.Errorf("unknown tool: %s", toolID)}
					continue
				}
				s.statuses[i] = toolStatus{tool: tool, writing: true}
			}
		})
		var cmds []tea.Cmd
		for i, status := range s.statuses {
			if status.writing && status.err == nil && status.status == "" {
				cmds = append(cmds, s.writeToolConfig(i))
			}
		}
		if len(cmds) > 0 {
			cmds = append(cmds, s.spinTick())
			return s, tea.Batch(cmds...)
		}
		if s.allComplete() {
			s.done = true
		}
		return s, nil

	case spinTickMsg:
		if !s.done {
			s.spinFrame++
			return s, s.spinTick()
		}
		return s, nil

	case writeCompleteMsg:
		s.statuses[m.index] = toolStatus{
			tool:   s.statuses[m.index].tool,
			status: m.status,
			err:    m.err,
		}
		if s.allComplete() {
			s.exportAPIKeyToShellProfile()
			s.done = true
		}
		return s, nil

	case tea.KeyMsg:
		if s.done {
			switch msg.(tea.KeyMsg).String() {
			case "enter", "ctrl+c", "q":
				return s, func() tea.Msg { return NextStepMsg{} }
			}
		}
	}

	return s, nil
}

func (s *ConfigureStep) writeToolConfig(index int) tea.Cmd {
	return func() tea.Msg {
		tool := s.statuses[index].tool

		// In inject mode, tool configs are applied at runtime via
		// `kimchi opencode` / `kimchi codex` — skip writing to disk.
		if s.mode == config.ModeInject {
			return writeCompleteMsg{index: index, status: "done"}
		}

		if tool.Write == nil {
			return writeCompleteMsg{index: index, status: "skipped", err: fmt.Errorf("no writer for tool")}
		}

		// Install the tool first if it's not present and has an installer.
		if !tool.DetectInstalled() && tool.CanInstall() {
			if err := tool.Install(); err != nil {
				return writeCompleteMsg{index: index, status: "failed", err: fmt.Errorf("install: %w", err)}
			}
		}

		err := tool.Write(s.scope, s.apiKey)
		if err != nil {
			return writeCompleteMsg{index: index, status: "failed", err: err}
		}
		return writeCompleteMsg{index: index, status: "done"}
	}
}

func (s *ConfigureStep) spinTick() tea.Cmd {
	return tea.Tick(100*time.Millisecond, func(t time.Time) tea.Msg {
		return spinTickMsg{}
	})
}

func (s *ConfigureStep) exportAPIKeyToShellProfile() {
	if s.apiKey == "" {
		return
	}
	path, err := config.ExportEnvToShellProfile(tools.APIKeyEnv, s.apiKey)
	s.shellProfilePath = path
	s.shellProfileErr = err

	// Persist the selected mode so `kimchi opencode` / `kimchi codex` can read it.
	if s.mode != "" {
		if cfg, err := config.Load(); err == nil {
			cfg.Mode = s.mode
			_ = config.Save(cfg)
		}
	}
}

func (s *ConfigureStep) ShellProfilePath() string {
	return s.shellProfilePath
}

func (s *ConfigureStep) allComplete() bool {
	for _, status := range s.statuses {
		if status.writing && status.status == "" && status.err == nil {
			return false
		}
	}
	return true
}

func (s *ConfigureStep) hasErrors() bool {
	for _, status := range s.statuses {
		if status.err != nil {
			return true
		}
	}
	return false
}

func (s *ConfigureStep) View() string {
	var b strings.Builder

	spinChars := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

	for _, status := range s.statuses {
		var icon string
		var msg string

		if status.err != nil {
			icon = Styles.Error.Render("✗")
			msg = Styles.Error.Render(fmt.Sprintf(" %s", status.err))
		} else if status.status == "done" {
			icon = Styles.Success.Render("✓")
			msg = Styles.Success.Render(" configured")
		} else if status.writing {
			spin := spinChars[s.spinFrame%len(spinChars)]
			icon = Styles.Spinner.Render(spin)
			msg = Styles.Spinner.Render(" configuring...")
		} else {
			icon = "○"
			msg = " waiting"
		}

		// Add model information for each tool
		modelInfo := s.getModelInfoForTool(status.tool.ID)
		line := fmt.Sprintf("  %s %s%s", icon, status.tool.Name, msg)
		if modelInfo != "" {
			line += fmt.Sprintf("\n    %s", Styles.Desc.Render(modelInfo))
		}

		b.WriteString(line)
		b.WriteString("\n")
	}

	if s.done {
		b.WriteString("\n")
		if s.hasErrors() {
			b.WriteString(Styles.Warning.Render("Configuration completed with errors."))
			b.WriteString("\n")
			b.WriteString(Styles.Help.Render("Press enter to exit"))
		} else {
			b.WriteString(Styles.Success.Render("Configuration complete!"))
			b.WriteString("\n\n")
			b.WriteString("Your tools are now connected to Kimchi's inference endpoint:\n")
			b.WriteString(Styles.Success.Render("https://llm.kimchi.dev"))
			b.WriteString("\n\n")
			b.WriteString("Each tool has been configured with optimal models for its use case:")
			b.WriteString("\n")
			fmt.Fprintf(&b, "• Primary model → %s", tools.MainModel.Slug)
			b.WriteString("\n")
			fmt.Fprintf(&b, "• Coding subagent → %s", tools.CodingModel.Slug)
			b.WriteString("\n")
			fmt.Fprintf(&b, "• Secondary subagent → %s", tools.SubModel.Slug)
			b.WriteString("\n")
			if s.shellProfilePath != "" {
				fmt.Fprintf(&b, "\n%s exported to %s\n", tools.APIKeyEnv, s.shellProfilePath)
			} else if s.shellProfileErr != nil {
				fmt.Fprintf(&b, "\n%s\n", Styles.Warning.Render(fmt.Sprintf("Could not export %s to shell profile: %v", tools.APIKeyEnv, s.shellProfileErr)))
			}
			if s.hasGenericTool() {
				b.WriteString(s.renderGenericEnvBlock())
			}
			b.WriteString("\n")
			b.WriteString(Styles.Help.Render("Press enter to exit"))
		}
	}

	return b.String()
}

func (s *ConfigureStep) getModelInfoForTool(toolID tools.ToolID) string {
	m := tools.MainModel.Slug
	c := tools.CodingModel.Slug
	s2 := tools.SubModel.Slug

	switch toolID {
	case tools.ToolOpenCode:
		return fmt.Sprintf("→ %s (primary) + %s (coding) + %s (sub)", m, c, s2)
	case tools.ToolContinue:
		return fmt.Sprintf("→ %s (primary) + %s (coding) + %s (sub)", m, c, s2)
	case tools.ToolWindsurf:
		return fmt.Sprintf("→ %s (primary) + %s (coding) + %s (sub)", m, c, s2)
	case tools.ToolZed:
		return fmt.Sprintf("→ %s (primary model)", m)
	case tools.ToolCodex:
		return fmt.Sprintf("→ %s (code generation and debugging)", c)
	case tools.ToolCline:
		return fmt.Sprintf("→ %s (action) + %s (planning)", c, m)
	case tools.ToolGSD2:
		return fmt.Sprintf("→ %s (default) + %s (coding) + %s (sub)", m, c, s2)
	case tools.ToolOpenClaw:
		return fmt.Sprintf("→ %s (primary) + %s (fallback) + %s (fallback)", m, c, s2)
	case tools.ToolCursor:
		return fmt.Sprintf("→ %s (composer) + %s (coding) + %s (sub)", m, c, s2)
	case tools.ToolClaudeCode:
		return "→ Kimchi endpoint configured (Claude Code manages models)"
	case tools.ToolGeneric:
		return "→ Environment variables for Kimchi endpoint"
	default:
		return ""
	}
}

func (s *ConfigureStep) hasGenericTool() bool {
	for _, id := range s.toolIDs {
		if id == tools.ToolGeneric {
			return true
		}
	}
	return false
}

func (s *ConfigureStep) renderGenericEnvBlock() string {
	var b strings.Builder
	b.WriteString("\n")
	b.WriteString("Set these in your shell to use the Generic integration:\n")
	fmt.Fprintf(&b, "  export %s=%s\n", tools.APIKeyEnv, s.apiKey)
	fmt.Fprintf(&b, "  export OPENAI_API_KEY=%s\n", s.apiKey)
	fmt.Fprintf(&b, "  export OPENAI_BASE_URL=%s\n", tools.BaseURL())
	return b.String()
}

func (s *ConfigureStep) Name() string {
	return "Configuring tools"
}

func (s *ConfigureStep) Info() StepInfo {
	bindings := []KeyBinding{}
	if s.done {
		bindings = append(bindings, BindingsConfirm)
	}
	return StepInfo{
		Name:        "Configuring tools",
		KeyBindings: bindings,
	}
}
