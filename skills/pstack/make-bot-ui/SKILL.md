---
name: make-bot-ui
description: "Explain the unavailable upstream automation-card UI capability when asked to render or format a Cursor Automation bot card. This Pi port does not implement that product-specific UI."
disable-model-invocation: true
---

# Make Bot UI

This upstream workflow targets Cursor Automations' private rendering protocol. Pi does not expose that protocol, and this package does not emulate it.

Tell the user the capability is unavailable in this port. Return ordinary Markdown status instead: name, state, last result, evidence link if one exists, and next action. Never call Cursor automation endpoints or invent an automation ID.
