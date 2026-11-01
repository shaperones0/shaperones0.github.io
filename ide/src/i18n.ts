import { language } from "./settings";

const ru = {
  run: "Запустить",
  stop: "Стоп",
  save: "Сохранить на диск",
  open: "Открыть файл",
  more: "Ещё",
  code: "Код",
  console: "Консоль",
  closeConsole: "Скрыть консоль",
  themeSystem: "Тема: системная",
  themeLight: "Тема: светлая",
  themeDark: "Тема: тёмная",
  language: "Language: English",
  rename: "Переименовать файл",
  editorLabel: "Редактор кода",
  inputLabel: "Ввод программы",
  downloading: "Загрузка Python: {percent}%",
  starting: "Запуск…",
  downloadFailed: "Не удалось загрузить Python. Проверьте интернет и нажмите «Запустить» ещё раз.",
  exited: "Программа завершена с кодом {status}",
  stopped: "Программа остановлена",
  crashed: "Программа исчерпала память или стек, и интерпретатор пришлось перезапустить. Код сохранён.",
  savedInBrowser: "Сохранено в браузере",
  savedToDisk: "Сохранено: {name}",
  opened: "Открыт файл {name}. Ctrl+Z вернёт прежний код",
  openedCp1251: "Открыт файл {name} (кодировка Windows-1251). Ctrl+Z вернёт прежний код",
  fileTooLarge: "Файл слишком большой для редактора",
  fileFailed: "Не удалось открыть файл",
  saveFailed: "Не удалось сохранить файл",
  storageUnavailable: "Браузер не даёт сохранять код на этом сайте. Сохраняйте его на диск.",
  isolationFailed: "Не удалось подготовить запуск программ. Обновите страницу. Если не поможет, откройте сайт в обычном окне браузера, а не в приватном.",
  isolationUnsupported: "Этот браузер или режим не поддерживает запуск программ. Откройте сайт в обычном окне браузера.",
};

type Messages = typeof ru;

const en: Messages = {
  run: "Run",
  stop: "Stop",
  save: "Save to disk",
  open: "Open file",
  more: "More",
  code: "Code",
  console: "Console",
  closeConsole: "Hide console",
  themeSystem: "Theme: system",
  themeLight: "Theme: light",
  themeDark: "Theme: dark",
  language: "Язык: русский",
  rename: "Rename file",
  editorLabel: "Code editor",
  inputLabel: "Program input",
  downloading: "Downloading Python: {percent}%",
  starting: "Starting…",
  downloadFailed: "Could not download Python. Check your connection and press Run again.",
  exited: "Program exited with code {status}",
  stopped: "Program stopped",
  crashed: "The program ran out of memory or stack, so the interpreter had to restart. Your code is saved.",
  savedInBrowser: "Saved in browser",
  savedToDisk: "Saved: {name}",
  opened: "Opened {name}. Ctrl+Z brings back the previous code",
  openedCp1251: "Opened {name} (Windows-1251 encoding). Ctrl+Z brings back the previous code",
  fileTooLarge: "This file is too large for the editor",
  fileFailed: "Could not open the file",
  saveFailed: "Could not save the file",
  storageUnavailable: "This browser won't let the site store your code. Save it to disk instead.",
  isolationFailed: "Could not set up running programs. Reload the page. If that doesn't help, open the site in a normal browser window, not a private one.",
  isolationUnsupported: "This browser or mode can't run programs. Open the site in a normal browser window.",
};

const messages = { ru, en };

export function t(key: keyof Messages, values: Record<string, string | number> = {}) {
  return messages[language.value][key].replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
}

// CodeMirror's own interface text, for the find and replace panel.
export const editorPhrases: Record<string, Record<string, string>> = {
  ru: {
    Find: "Найти",
    Replace: "Заменить",
    next: "далее",
    previous: "назад",
    all: "все",
    "match case": "учитывать регистр",
    "by word": "целое слово",
    regexp: "рег. выражение",
    replace: "заменить",
    "replace all": "заменить все",
    close: "закрыть",
    "Go to line": "Перейти к строке",
    go: "перейти",
    "current match": "текущее совпадение",
    "on line": "на строке",
    "replaced match on line $": "заменено на строке $",
    "replaced $ matches": "заменено совпадений: $",
  },
  en: {},
};
