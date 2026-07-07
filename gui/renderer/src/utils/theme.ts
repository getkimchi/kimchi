export type Theme = "light" | "dark";

const STORAGE_KEY = "kimchi-theme";

export function getStoredTheme(): Theme {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "dark" ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
    if (theme === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
    } else {
        document.documentElement.removeAttribute("data-theme");
    }
}

export function setTheme(theme: Theme) {
    localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
}

// Call once, as early as possible, so the app never paints in the wrong
// theme and then flashes to the right one.
export function initTheme() {
    applyTheme(getStoredTheme());
}
