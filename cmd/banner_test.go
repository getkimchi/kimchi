package cmd

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
	"github.com/castai/kimchi/internal/tools"
	"github.com/stretchr/testify/assert"
)

func testConfig() *config.Config {
	return &config.Config{
		Mode:            config.ModeInject,
		GSDInstalledFor: []string{"opencode"},
	}
}

func TestPrintBanner_ContainsKimchi(t *testing.T) {
	t.Setenv("NO_COLOR", "1")

	var buf bytes.Buffer
	printBanner(&buf, tools.ToolOpenCode, testConfig(), models.New())

	output := buf.String()
	assert.Contains(t, output, "kimchi")
	assert.Contains(t, output, "opencode")
}

func TestPrintBanner_NoColor(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	t.Setenv("TERM", "")

	var buf bytes.Buffer
	printBanner(&buf, tools.ToolOpenCode, testConfig(), models.New())

	output := buf.String()
	assert.NotContains(t, output, "\033[", "output should not contain ANSI escape codes when NO_COLOR is set")
}

func TestPrintBanner_ColorEnabled(t *testing.T) {
	_ = os.Unsetenv("NO_COLOR")
	t.Cleanup(func() { _ = os.Unsetenv("NO_COLOR") })
	t.Setenv("TERM", "xterm-256color")

	var buf bytes.Buffer
	printBanner(&buf, tools.ToolOpenCode, testConfig(), models.New())

	output := buf.String()
	assert.Contains(t, output, "\033[", "output should contain ANSI escape codes when color is enabled")
	assert.Contains(t, output, "opencode")
}

func TestPrintBanner_ShowsModels(t *testing.T) {
	t.Setenv("NO_COLOR", "1")

	var buf bytes.Buffer
	printBanner(&buf, tools.ToolOpenCode, testConfig(), models.New())

	output := buf.String()
	assert.Contains(t, output, "Models:")
	assert.Contains(t, output, "reasoning")
	assert.Contains(t, output, "coding")
}

func TestPrintBanner_ShowsGSDActive(t *testing.T) {
	t.Setenv("NO_COLOR", "1")

	var buf bytes.Buffer
	printBanner(&buf, tools.ToolOpenCode, testConfig(), models.New())

	assert.Contains(t, buf.String(), "active")
}

func TestPrintBanner_ShowsGSDNotInstalled(t *testing.T) {
	t.Setenv("NO_COLOR", "1")

	cfg := &config.Config{Mode: config.ModeInject}
	var buf bytes.Buffer
	printBanner(&buf, tools.ToolCodex, cfg, models.New())

	assert.Contains(t, buf.String(), "not installed")
}

func TestPrintBanner_OutputEndsWithNewline(t *testing.T) {
	t.Setenv("NO_COLOR", "1")

	var buf bytes.Buffer
	printBanner(&buf, tools.ToolOpenCode, testConfig(), models.New())

	output := buf.String()
	assert.True(t, strings.HasSuffix(output, "\n"), "banner output should end with a newline")
}
