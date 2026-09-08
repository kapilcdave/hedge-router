# hedge router status

A read-only status companion for Claude Code, Codex, and OpenCode. Every integration renders the same compact compute-exposure line from the local hedge router ledger:

```text
hedge router · spend $1.25 · 1.5M tokens · paper +$0.42
```

Install the repository command first with `npm link` from the hedge router repository.

## Claude Code

Claude Code does not allow a plugin to set the main status line automatically. Add this to your user or project `settings.json`, replacing the path with this plugin's absolute path:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/absolute/path/to/hedge-router-status/scripts/claude-statusline.sh",
    "refreshInterval": 2
  }
}
```

The plugin also has a Claude Code manifest and the shared `hedge-router-status` skill.

## Codex

Install this directory as a local Codex plugin. The included skill answers requests such as “show my hedge router exposure status” using the same read-only command. Codex plugins do not currently expose a custom footer/status-line slot, so the value is shown on request rather than pinned in the app chrome.

## OpenCode

Add the TUI entrypoint to `cli.json`, using an absolute path if this repository is not your current config directory:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "/absolute/path/to/hedge-router-status/opencode/tui.tsx"
  ]
}
```

It appends the lowercase status beside OpenCode's prompt-footer status and refreshes every two seconds.
