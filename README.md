# pi-extensions

Pi extensions, including configurable macOS auto dark/light theme switching.

## Install

From GitHub:

```bash
pi install git:github.com/dinhtungdu/pi-extensions
```

Local development:

```bash
pi -e ./extensions/auto-dark-mode.ts
pi install /path/to/pi-extensions
```

## Config

Global: `~/.pi/agent/auto-dark-mode.json`
Project override: `<cwd>/.pi/auto-dark-mode.json`

```json
{
	"darkTheme": "dark",
	"lightTheme": "light",
	"intervalMs": 2000,
	"notify": false
}
```

Project config overrides global config.

## Commands

- `/auto-theme` or `/auto-theme status` — show current mapping
- `/auto-theme pick` — choose dark/light themes interactively
- `/auto-theme dark <theme>` — save dark-mode theme
- `/auto-theme light <theme>` — save light-mode theme

If project config exists, commands write there; otherwise they write global config.
