package tools

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"runtime"

	"github.com/castai/kimchi/internal/config"
	"github.com/castai/kimchi/internal/models"

	_ "modernc.org/sqlite"
)

const (
	cursorReactiveStorageKey = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser"
	cursorAPIKeyRow          = "cursorAuth/openAIKey"
)

func init() {
	register(Tool{
		ID:          ToolCursor,
		Name:        "Cursor",
		Description: "AI-powered code editor",
		ConfigPath:  getCursorDBPath(),
		BinaryName:  "cursor",
		IsInstalled: detectCursor,
		Write:       writeCursor,
	})
}

func getCursorDBPath() string {
	switch runtime.GOOS {
	case "darwin":
		return "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb"
	default:
		return "~/.config/Cursor/User/globalStorage/state.vscdb"
	}
}

func detectCursor() bool {
	dbPath, err := config.ScopePaths(config.ScopeGlobal, getCursorDBPath())
	if err != nil {
		return false
	}
	if _, err := os.Stat(dbPath); err == nil {
		return true
	}
	if runtime.GOOS == "darwin" {
		if _, err := os.Stat("/Applications/Cursor.app"); err == nil {
			return true
		}
	}
	return false
}

// Scope is ignored: Cursor stores its state in a single per-user SQLite database,
// so there is no project-local equivalent to write to.
func writeCursor(_ config.ConfigScope, apiKey string, reg *models.Registry) error {
	if apiKey == "" {
		return fmt.Errorf("API key not configured")
	}

	dbPath, err := config.ScopePaths(config.ScopeGlobal, getCursorDBPath())
	if err != nil {
		return fmt.Errorf("get config path: %w", err)
	}

	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		return fmt.Errorf("cursor database not found at %s", dbPath)
	}

	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.Close() //nolint:errcheck

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	var blob string
	err = tx.QueryRow("SELECT value FROM ItemTable WHERE key = ?", cursorReactiveStorageKey).Scan(&blob)
	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("read config: %w", err)
	}

	storage := make(map[string]any)
	if blob != "" {
		if err := json.Unmarshal([]byte(blob), &storage); err != nil {
			return fmt.Errorf("parse config: %w", err)
		}
	}

	mergeCursorConfig(storage, reg)

	newBlob, err := json.Marshal(storage)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	_, err = tx.Exec("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", cursorReactiveStorageKey, string(newBlob))
	if err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	_, err = tx.Exec("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)", cursorAPIKeyRow, apiKey)
	if err != nil {
		return fmt.Errorf("write API key: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	return nil
}

func cursorModelSlug(slug string) string {
	return providerName + "/" + slug
}

func mergeCursorConfig(storage map[string]any, reg *models.Registry) {
	storage["openAIBaseUrl"] = baseURL
	storage["useOpenAIKey"] = true

	aiSettings, _ := storage["aiSettings"].(map[string]any)
	if aiSettings == nil {
		aiSettings = make(map[string]any)
	}

	main := cursorModelSlug(reg.Main().Slug)
	coding := cursorModelSlug(reg.Coding().Slug)
	sub := cursorModelSlug(reg.Sub().Slug)

	modelSlugs := []string{main, coding, sub}

	aiSettings["userAddedModels"] = appendUnique(toStringSlice(aiSettings["userAddedModels"]), modelSlugs)
	aiSettings["modelOverrideEnabled"] = appendUnique(toStringSlice(aiSettings["modelOverrideEnabled"]), modelSlugs)
	aiSettings["modelOverrideDisabled"] = removeAll(toStringSlice(aiSettings["modelOverrideDisabled"]), modelSlugs)

	modelConfig, _ := aiSettings["modelConfig"].(map[string]any)
	if modelConfig == nil {
		modelConfig = make(map[string]any)
	}

	cursorModelEntry := func(slug string) map[string]any {
		return map[string]any{
			"modelName": slug,
			"maxMode":   false,
			"selectedModels": []any{
				map[string]any{
					"modelId":    slug,
					"parameters": []any{},
				},
			},
		}
	}

	modelConfig["composer"] = cursorModelEntry(main)
	modelConfig["cmd-k"] = cursorModelEntry(coding)
	modelConfig["background-composer"] = cursorModelEntry(main)
	modelConfig["plan-execution"] = cursorModelEntry(coding)
	modelConfig["spec"] = cursorModelEntry(main)
	modelConfig["deep-search"] = cursorModelEntry(main)
	modelConfig["quick-agent"] = cursorModelEntry(sub)
	modelConfig["composer-ensemble"] = cursorModelEntry(main)

	aiSettings["modelConfig"] = modelConfig

	storage["aiSettings"] = aiSettings
}

func toStringSlice(v any) []string {
	raw, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func appendUnique(existing, add []string) []string {
	seen := make(map[string]bool, len(existing))
	for _, s := range existing {
		seen[s] = true
	}
	for _, s := range add {
		if !seen[s] {
			existing = append(existing, s)
			seen[s] = true
		}
	}
	return existing
}

func removeAll(slice []string, remove []string) []string {
	drop := make(map[string]bool, len(remove))
	for _, s := range remove {
		drop[s] = true
	}
	out := make([]string, 0, len(slice))
	for _, s := range slice {
		if !drop[s] {
			out = append(out, s)
		}
	}
	return out
}
