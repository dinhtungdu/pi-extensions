# pi-extensions

Pi extensions:

- `auto-dark-mode` — macOS dark/light theme switching
- `codemode` — Cloudflare-Codemode-style JS tool orchestration for pi built-in tools
- `goal` — Codex-style persisted goals with `/goal`, goal tools, and hidden continuation

## Install

All extensions from GitHub:

```bash
pi install git:github.com/dinhtungdu/pi-extensions
```

Selected extensions only:

```json
{
	"packages": [
		{
			"source": "git:github.com/dinhtungdu/pi-extensions",
			"extensions": ["extensions/auto-dark-mode.ts", "extensions/code-mode.ts", "extensions/goal.ts"],
			"skills": [],
			"prompts": [],
			"themes": []
		}
	]
}
```

Put that in `~/.pi/agent/settings.json` for global install, or `.pi/settings.json` for project-local install. If already installed, replace the plain package string with the object form.

Local development:

```bash
pi -e ./extensions/auto-dark-mode.ts
pi -e ./extensions/code-mode.ts
pi -e ./extensions/goal.ts
pi install /path/to/pi-extensions
```

## Codemode

Registers tool: `codemode`.

Use for multi-step logic over active built-in pi tools:

```js
async () => {
	const files = await codemode.ls({ path: "." });
	const matches = await codemode.grep({ pattern: "TODO", path: ".", limit: 20 });
	return { files, matches };
}
```

Notes:

- Exposes only active built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- JavaScript only. No TypeScript syntax.
- Local Node worker/vm isolation, not Cloudflare Workers security. Do not run hostile code. Tiny sandbox, not Fort Knox.
- Output truncated to pi defaults; full output saved to temp when needed.

## Goal

Registers command: `/goal`.

Commands:

```text
/goal <objective>
/goal <objective> --budget 100000
/goal status
/goal pause
/goal resume
/goal clear
```

Registers tools: `get_goal`, `create_goal`, `update_goal`.

Notes:

- `/goal <objective>` persists the goal, then submits the objective so the agent starts immediately.
- Active goals auto-continue with hidden continuation messages until `update_goal({ status: "complete" })`, `/goal pause`, `/goal clear`, budget exhaustion, or a no-tool continuation.
- Goal state is stored in the pi session branch via custom entries; it survives reload/resume/fork.
- Objectives should include scope, success criteria, constraints, and verification commands.

## Auto dark mode config

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
