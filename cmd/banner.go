package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"
	"github.com/castai/kimchi/internal/tools"
)

const (
	ansiReset = "\033[0m"
	ansiRed   = "\033[38;5;196m"
	ansiBold  = "\033[1m"
	ansiDim   = "\033[2m"
)

func colorEnabled() bool {
	if _, set := os.LookupEnv("NO_COLOR"); set {
		return false
	}
	// Windows Terminal and modern PowerShell support ANSI but don't set TERM.
	if os.Getenv("WT_SESSION") != "" || os.Getenv("COLORTERM") != "" {
		return true
	}
	term := os.Getenv("TERM")
	return term != "" && term != "dumb"
}

func printBanner(w io.Writer, toolID tools.ToolID, cfg *config.Config, reg *models.Registry) {
	line := strings.Repeat("\u2500", 45)
	modelStr := fmt.Sprintf("%s (reasoning) / %s (coding)", reg.Main().Slug, reg.Coding().Slug)
	gsdStatus := "not installed"
	for _, t := range cfg.GSDInstalledFor {
		if strings.Contains(t, string(toolID)) {
			gsdStatus = "active"
			break
		}
	}

	if colorEnabled() {
		_, _ = fmt.Fprintf(w, "\n  %s%s\U0001F96C\U0001F336  kimchi%s\n", ansiBold, ansiRed, ansiReset)
		_, _ = fmt.Fprintf(w, "  %s%s%s\n", ansiDim, line, ansiReset)
		_, _ = fmt.Fprintf(w, "  %sTarget:%s  %s\n", ansiDim, ansiReset, toolID)
		_, _ = fmt.Fprintf(w, "  %sModels:%s  %s\n", ansiDim, ansiReset, modelStr)
		_, _ = fmt.Fprintf(w, "  %sGSD:%s     %s\n", ansiDim, ansiReset, gsdStatus)
		_, _ = fmt.Fprintf(w, "  %sMode:%s    %s\n", ansiDim, ansiReset, cfg.Mode)
		_, _ = fmt.Fprintf(w, "  %s%s%s\n\n", ansiDim, line, ansiReset)
	} else {
		_, _ = fmt.Fprintf(w, "\n  kimchi\n")
		_, _ = fmt.Fprintf(w, "  %s\n", strings.Repeat("-", 45))
		_, _ = fmt.Fprintf(w, "  Target:  %s\n", toolID)
		_, _ = fmt.Fprintf(w, "  Models:  %s\n", modelStr)
		_, _ = fmt.Fprintf(w, "  GSD:     %s\n", gsdStatus)
		_, _ = fmt.Fprintf(w, "  Mode:    %s\n", cfg.Mode)
		_, _ = fmt.Fprintf(w, "  %s\n\n", strings.Repeat("-", 45))
	}
}
