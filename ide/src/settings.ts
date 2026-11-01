// Theme and language. The inline script in the page's <head> applies them before first paint.
import { effect, signal } from "@preact/signals";

export type ThemeSetting = "system" | "light" | "dark";
export type Language = "ru" | "en";

const THEME_KEY = "ide-theme";
const LANG_KEY = "ide-lang";

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

const savedTheme = read(THEME_KEY);
export const theme = signal<ThemeSetting>(savedTheme === "light" || savedTheme === "dark" ? savedTheme : "system");
export const language = signal<Language>(read(LANG_KEY) === "en" ? "en" : "ru");

effect(() => {
  write(THEME_KEY, theme.value);
  if (theme.value === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme.value;
});

effect(() => {
  write(LANG_KEY, language.value);
  document.documentElement.lang = language.value;
});

export function cycleTheme() {
  theme.value = theme.value === "system" ? "light" : theme.value === "light" ? "dark" : "system";
}

export function toggleLanguage() {
  language.value = language.value === "ru" ? "en" : "ru";
}
