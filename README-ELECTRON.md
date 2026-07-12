# DOCS Editor — Electron-сборка

WYSIWYG-редактор документов на базе superdoc с JSON-прослойкой для RAG,
встроенным AI-агентом, canvas-вставками, внешними ресурсами и упаковкой в
формат DOCS. Запускается как desktop-приложение через Electron.

## Быстрый старт (Windows)

### 1. Установка окружения
```
install.bat
```
Скрипт установит bun (если нет), основные зависимости проекта, а также
electron и electron-builder.

### 2. Запуск без сборки (dev-режим)
```
run-dev.bat
```
Откроет два окна:
- **DOCS Editor — Next.js** — журнал dev-сервера (можно закрыть после запуска).
- **DOCS Editor — Electron** — само приложение.

### 3. Сборка установщика
```
build.bat
```

## Возможные проблемы

### "bun not found" в окне Next.js
bun установлен, но не в PATH. Решение:
1. Найдите путь к bun: откройте cmd, введите `where bun`
2. Если не найден — добавьте `C:\Users\ВАШ_ПОЛЬЗОВАТЕЛЬ\.bun\bin` в PATH
3. Или отредактируйте `run-dev.bat`: замените `bun run dev` на полный путь,
   например `"C:\Users\PC-01\.bun\bin\bun.exe" run dev`

### "electron.cmd not found"
Электрон не установлен. Решение:
```
install.bat
```
или вручную:
```
bun add -d electron electron-builder
```

### Пустое окно Electron
Next.js сервер ещё не готов. Решение:
1. Подождите 10-15 секунд (сервер компилирует superdoc — это долго)
2. Или увеличьте задержку в `run-dev.bat` (строка `timeout /t 10`)
3. Проверьте, что в окне "Next.js" нет ошибок

### Окно Electron показывает "connection refused"
Сервер упал. Откройте окно "Next.js" и проверьте ошибки.

В dev-режиме:
- Next.js отладочный индикатор (буква «N» в углу) **отключён** через
  `next.config.ts` (`devIndicators: false`).
- Стандартное меню File/Edit/View/... **убрано** через `electron/main.js`
  (`Menu.setApplicationMenu(null)`, `autoHideMenuBar: true`).

В собранной версии (production) отладочных элементов нет по определению.

## Структура

```
docs-editor/
├─ electron/
│  ├─ main.js          # Electron main: spawn next, окно без меню
│  └─ preload.js       # contextBridge к renderer
├─ src/                # Next.js приложение (superdoc + AI + RAG)
├─ public/             # статики
├─ prisma/             # схема БД
├─ next.config.ts      # devIndicators: false (нет «N»)
├─ package.json        # main: electron/main.js + build config
├─ install.bat         # установка bun + deps + electron
├─ run-dev.bat         # запуск dev (без сборки)
└─ build.bat           # сборка установщика electron-builder
```

## Подключение к LM Studio (или другой OpenAI-совместимой API)

1. Запустите LM Studio → вкладка Developer / Local Server.
2. Загрузите модель и нажмите Start Server (порт 1234 по умолчанию).
3. В приложении: панель «Настройки» → Base URL уже заполнен
   (`http://localhost:1234/v1`) → «Загрузить модели».
4. Выберите чат-модель и модель эмбеддингов.

**Важно про localhost в Electron:** Electron-приложение работает на той же
машине, где запущен LM Studio, поэтому `http://localhost:1234` доступен
напрямую. Если предпросмотр рендерится на облачном сервере (как в IDE), то
localhost там недоступен — в desktop-Electron этой проблемы нет.

## Архитектура

- **superdoc** (`@harbour-enterprises/superdoc`) — реальный DOCX-движок
  (OOXML, пагинация, форматирование). Монтируется через `SuperDocBridge`.
- **DocumentMap** (`src/lib/editor/types.ts`) — JSON-проекция блоков
  документа с эмбеддингами для RAG.
- **AI Executor** (`src/lib/editor/superdoc-bridge.ts`) — применяет
  JSON-команды агента через ProseMirror API (`schema.nodeFromJSON`,
  `tr.insert`, `editor.dispatch`).
- **DOCS packaging** (`/api/docs/export`) — zip: `document.docx` +
  `map.json` + `embeddings.json` + `externals/` + `scripts/` + `meta.json`.
