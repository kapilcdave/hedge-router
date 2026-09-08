---
name: hedge-router-status
description: Show or explain local compute spend, token exposure, and hedge paper P&L. Use when the user asks about hedge router status, compute exposure, gateway spend, or paper hedge results.
---

# hedge router status

Run `hedge-router status` to obtain the current compact, read-only status. Report the output exactly when the user only asks for status. Run `hedge-router report` when the user asks for a detailed explanation, then summarize compute spend, token exposure, gateway sources, and paper results in plain language.

Never claim that paper P&L is live trading profit. It is simulated research output. Do not read or expose prompts, code, filenames, paths, tool arguments, or tool output while reporting status.
