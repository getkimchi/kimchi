package steps

import (
	"bufio"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"text/template"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/castai/kimchi/internal/tools"
)

//go:embed prompts/welcome.txt
var welcomePromptFS embed.FS

var doneStreamStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("15")).Width(60)

type streamChunkMsg struct {
	content string
}

type streamDoneMsg struct{}

type streamStartMsg struct{}

type streamTimeoutMsg struct{}

type DoneParams struct {
	APIKey  string
	ToolIDs []tools.ToolID
}

type DoneStep struct {
	apiKey             string
	toolIDs            []tools.ToolID
	streamedMsg        strings.Builder
	streamDone         bool
	hasReceivedContent bool
	spin               spinner.Model

	streamMu     sync.Mutex
	streamCh     chan string
	streamCancel context.CancelFunc
	streamClose  sync.Once
}

func NewDoneStep(ctx context.Context, params DoneParams) *DoneStep {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("12"))

	return &DoneStep{
		apiKey:  params.APIKey,
		toolIDs: params.ToolIDs,
		spin:    sp,
	}
}

func (s *DoneStep) Init() tea.Cmd {
	return tea.Batch(
		func() tea.Msg { return streamStartMsg{} },
		s.spin.Tick,
		tea.Tick(15*time.Second, func(time.Time) tea.Msg { return streamTimeoutMsg{} }),
	)
}

func (s *DoneStep) Update(msg tea.Msg) (Step, tea.Cmd) {
	switch msg := msg.(type) {
	case streamStartMsg:
		s.streamMu.Lock()
		if s.streamCh == nil {
			s.streamCh = make(chan string, 100)
			ctx, cancel := context.WithCancel(context.Background())
			s.streamCancel = cancel
			go s.runStreamBackground(ctx)
		}
		s.streamMu.Unlock()
		return s, s.waitForChunk()

	case streamChunkMsg:
		s.hasReceivedContent = true
		s.streamedMsg.WriteString(msg.content)
		return s, s.waitForChunk()

	case streamDoneMsg:
		s.streamDone = true
		return s, nil

	case streamTimeoutMsg:
		if !s.hasReceivedContent {
			// No content received within 15s — cancel the stream goroutine
			// and fall back to the default message.
			s.streamMu.Lock()
			if s.streamCancel != nil {
				s.streamCancel()
			}
			ch := s.streamCh
			s.streamMu.Unlock()
			if ch != nil {
				go func() {
					defer func() { _ = recover() }()
					s.sendDefaultMessageTo(ch)
					s.closeStream()
				}()
			}
		}
		return s, nil

	case spinner.TickMsg:
		if !s.streamDone {
			var cmd tea.Cmd
			s.spin, cmd = s.spin.Update(msg)
			return s, cmd
		}

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			return s, tea.Quit
		case "enter":
			return s, tea.Quit
		}
	}

	return s, nil
}

func (s *DoneStep) waitForChunk() tea.Cmd {
	return func() tea.Msg {
		s.streamMu.Lock()
		ch := s.streamCh
		s.streamMu.Unlock()

		if ch == nil {
			return streamDoneMsg{}
		}

		content, ok := <-ch
		if !ok {
			return streamDoneMsg{}
		}
		return streamChunkMsg{content: content}
	}
}

func (s *DoneStep) closeStream() {
	s.streamClose.Do(func() { close(s.streamCh) })
}

func (s *DoneStep) runStreamBackground(ctx context.Context) {
	// Recover from any send-on-closed-channel panic that may occur if the
	// timeout handler closes the channel while we are still sending to it.
	defer func() { _ = recover() }()

	if s.apiKey == "" {
		s.sendDefaultMessage()
		s.closeStream()
		return
	}

	var toolInfo []string
	for _, toolID := range s.toolIDs {
		if tool, ok := tools.ByID(toolID); ok {
			tip := s.getToolTip(toolID)
			toolInfo = append(toolInfo, fmt.Sprintf("%s: %s", tool.Name, tip))
		}
	}

	toolsSection := "No specific tools configured."
	if len(toolInfo) > 0 {
		toolsSection = strings.Join(toolInfo, "\n")
	}

	prompt, err := s.buildPrompt(toolsSection)
	if err != nil {
		if ctx.Err() == nil {
			s.sendDefaultMessage()
		}
		s.closeStream()
		return
	}

	reqBody := map[string]any{
		"model": tools.MainModel.Slug,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
		"stream":     true,
		"max_tokens": 500,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		if ctx.Err() == nil {
			s.sendDefaultMessage()
		}
		s.closeStream()
		return
	}

	req, err := http.NewRequestWithContext(ctx, "POST", "https://llm.kimchi.dev/openai/v1/chat/completions", strings.NewReader(string(jsonBody)))
	if err != nil {
		if ctx.Err() == nil {
			s.sendDefaultMessage()
		}
		s.closeStream()
		return
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			s.sendDefaultMessage()
		}
		s.closeStream()
		return
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		if ctx.Err() == nil {
			s.sendDefaultMessage()
		}
		s.closeStream()
		return
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return
		}
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			s.closeStream()
			return
		}

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			content := chunk.Choices[0].Delta.Content
			s.streamCh <- content
		}
	}
	s.closeStream()
}

func (s *DoneStep) sendDefaultMessage() {
	s.sendDefaultMessageTo(s.streamCh)
}

func (s *DoneStep) sendDefaultMessageTo(ch chan string) {
	ch <- "Welcome to Kimchi!\n\n"
	ch <- "You've just unlocked access to powerful open-source models\n"
	ch <- "via Kimchi's infrastructure!\n\n"
	ch <- tools.MainModel.Slug + " is your primary model for reasoning, planning,\n"
	ch <- "code generation, and image processing.\n\n"
	ch <- tools.CodingModel.Slug + " is your coding subagent for writing,\n"
	ch <- "refactoring, and debugging code.\n\n"
	ch <- tools.SubModel.Slug + " is your secondary subagent available\n"
	ch <- "across all your configured tools.\n\n"
	ch <- "Don't be shy - experiment boldly! Ask tough questions,\n"
	ch <- "request detailed explanations, generate entire features.\n"
	ch <- "These models are here to help you build amazing things.\n\n"
	ch <- "Enjoy the journey!"
}

func (s *DoneStep) getToolTip(toolID tools.ToolID) string {
	switch toolID {
	case tools.ToolOpenCode:
		return "Run 'opencode' in any project directory to start. Use Ctrl+K for quick actions."
	case tools.ToolZed:
		return "Open Zed and use Cmd+Enter to send prompts to the AI assistant."
	case tools.ToolCodex:
		return fmt.Sprintf("Run 'codex' with a prompt. Ensure %s is set in your environment.", tools.APIKeyEnv)
	case tools.ToolCline:
		return "Open VS Code with Cline extension installed and start a new task."
	case tools.ToolClaudeCode:
		return "Run 'claude' in any project directory. Claude Code will use Kimchi endpoint for API calls."
	case tools.ToolGeneric:
		return "Add the export lines shown in the previous step to your shell profile, then open a new terminal."
	default:
		return "Check the tool's documentation for getting started."
	}
}

func (s *DoneStep) View() string {
	var b strings.Builder

	b.WriteString(Styles.Title.Render("Setup Complete"))
	b.WriteString("\n\n")

	if len(s.toolIDs) > 0 {
		b.WriteString("Configured tools:\n")
		for _, toolID := range s.toolIDs {
			tool, ok := tools.ByID(toolID)
			if ok {
				fmt.Fprintf(&b, "  %s %s\n", Styles.Success.Render("✓"), tool.Name)
			}
		}
		b.WriteString("\n")
	}

	msg := s.streamedMsg.String()
	msg = filterThinking(msg)
	msg = wordWrap(msg, 60)
	b.WriteString(doneStreamStyle.Render(msg))

	b.WriteString("\n\n")
	if s.streamDone {
		b.WriteString(Styles.Help.Render("Press Enter to exit"))
	} else {
		fmt.Fprintf(&b, "%s Generating welcome message...  %s", s.spin.View(), Styles.Help.Render("(Enter to skip)"))
	}

	return b.String()
}

func (s *DoneStep) buildPrompt(toolsSection string) (string, error) {
	tmplContent, err := welcomePromptFS.ReadFile("prompts/welcome.txt")
	if err != nil {
		return "", fmt.Errorf("read welcome prompt: %w", err)
	}

	tmpl, err := template.New("welcome").Parse(string(tmplContent))
	if err != nil {
		return "", fmt.Errorf("parse welcome template: %w", err)
	}

	var buf strings.Builder
	data := map[string]string{
		"Tools":       toolsSection,
		"MainModel":   tools.MainModel.Slug,
		"CodingModel": tools.CodingModel.Slug,
		"SubModel":    tools.SubModel.Slug,
	}
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("execute welcome template: %w", err)
	}

	return buf.String(), nil
}

func wordWrap(text string, width int) string {
	var result strings.Builder
	lines := strings.Split(text, "\n")

	for _, line := range lines {
		if len(line) <= width {
			result.WriteString(line)
			result.WriteString("\n")
			continue
		}

		words := strings.Fields(line)
		if len(words) == 0 {
			result.WriteString("\n")
			continue
		}

		currentLen := 0
		for _, word := range words {
			wordLen := len(word)
			if currentLen == 0 {
				result.WriteString(word)
				currentLen = wordLen
			} else if currentLen+1+wordLen <= width {
				result.WriteString(" ")
				result.WriteString(word)
				currentLen += 1 + wordLen
			} else {
				result.WriteString("\n")
				result.WriteString(word)
				currentLen = wordLen
			}
		}
		result.WriteString("\n")
	}

	return result.String()
}

func filterThinking(s string) string {
	for {
		start := strings.Index(s, "<")
		if start == -1 {
			return s
		}
		end := strings.Index(s[start:], ">")
		if end == -1 {
			return s
		}
		tag := s[start+1 : start+end]
		if tag == "think" || strings.HasPrefix(tag, "think>") {
			closeIdx := strings.Index(s, "</think>")
			if closeIdx == -1 {
				closeIdx = strings.Index(s, ">")
				if closeIdx != -1 && closeIdx > start+end {
					s = s[:start] + s[closeIdx+1:]
					continue
				}
				return s[:start]
			}
			s = s[:start] + s[closeIdx+8:]
			continue
		}
		return s
	}
}

func (s *DoneStep) Name() string {
	return "Done"
}

func (s *DoneStep) Info() StepInfo {
	return StepInfo{
		Name: "Done",
		KeyBindings: []KeyBinding{
			{Key: "↵", Text: "exit"},
		},
	}
}
