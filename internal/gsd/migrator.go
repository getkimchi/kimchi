package gsd

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"strings"

	"github.com/castai/kimchi/internal/models"
	"gopkg.in/yaml.v3"
)

type Migrator struct{}

func NewMigrator() *Migrator {
	return &Migrator{}
}

func (m *Migrator) Migrate(installations []Installation, reg *models.Registry) ([]string, error) {
	var migrated []string

	for _, install := range installations {
		for _, agentFile := range install.AgentFiles {
			if err := m.updateAgentFile(agentFile, install.Type, reg); err != nil {
				return nil, fmt.Errorf("update %s: %w", agentFile.Name, err)
			}
			migrated = append(migrated, agentFile.Path)
		}
	}

	return migrated, nil
}

func (m *Migrator) updateAgentFile(af AgentFile, installType InstallationType, reg *models.Registry) error {
	_, err := Backup(af.Path)
	if err != nil {
		return fmt.Errorf("backup: %w", err)
	}

	frontmatter, body, err := m.parseFrontmatter(af.RawContent)
	if err != nil {
		return fmt.Errorf("parse frontmatter: %w", err)
	}

	model := m.determineModelForAgent(af.Name, installType, reg)
	frontmatter["model"] = model

	newContent, err := m.serializeFrontmatter(frontmatter, body)
	if err != nil {
		return fmt.Errorf("serialize frontmatter: %w", err)
	}

	if err := os.WriteFile(af.Path, []byte(newContent), 0600); err != nil {
		return fmt.Errorf("write file: %w", err)
	}

	return nil
}

func (m *Migrator) parseFrontmatter(content string) (map[string]any, string, error) {
	if !strings.HasPrefix(content, "---\n") {
		return make(map[string]any), content, nil
	}

	scanner := bufio.NewScanner(strings.NewReader(content))
	scanner.Scan()

	var yamlBuf bytes.Buffer
	var bodyBuf bytes.Buffer
	var inFrontmatter = true
	var foundEnd = false

	for scanner.Scan() {
		line := scanner.Text()
		if inFrontmatter && line == "---" {
			inFrontmatter = false
			foundEnd = true
			continue
		}

		if inFrontmatter {
			yamlBuf.WriteString(line)
			yamlBuf.WriteString("\n")
		} else {
			bodyBuf.WriteString(line)
			bodyBuf.WriteString("\n")
		}
	}

	if !foundEnd {
		return make(map[string]any), content, nil
	}

	var frontmatter map[string]any
	if yamlBuf.Len() > 0 {
		if err := yaml.Unmarshal(yamlBuf.Bytes(), &frontmatter); err != nil {
			return nil, "", fmt.Errorf("parse YAML: %w", err)
		}
	}

	if frontmatter == nil {
		frontmatter = make(map[string]any)
	}

	return frontmatter, bodyBuf.String(), nil
}

func (m *Migrator) serializeFrontmatter(frontmatter map[string]any, body string) (string, error) {
	yamlData, err := yaml.Marshal(frontmatter)
	if err != nil {
		return "", fmt.Errorf("marshal YAML: %w", err)
	}

	var buf bytes.Buffer
	buf.WriteString("---\n")
	buf.Write(yamlData)
	buf.WriteString("---\n")
	buf.WriteString(body)

	return buf.String(), nil
}

func (m *Migrator) determineModelForAgent(agentName string, installType InstallationType, reg *models.Registry) string {
	var model string
	for _, name := range PlanningAgents {
		if name == agentName {
			model = reg.Main().Slug
			break
		}
	}

	if model == "" {
		for _, name := range ExecutionAgents {
			if name == agentName {
				model = reg.Coding().Slug
				break
			}
		}
	}

	if model == "" {
		model = reg.Main().Slug
	}

	// For opencode, prefix the model with the provider name
	if installType == InstallationOpenCode {
		model = "kimchi/" + model
	}

	return model
}
