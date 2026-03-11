---
name: self-improvement
description: "Extract learnings, mistakes, and new rules from sessions automatically on /new or /reset"
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
      },
  }
---

# Self-Improvement Hook

Automatically analyzes completed sessions and extracts:
- **Mistakes & Retros** → appended to `memory/retro.md`
- **New Rules** → appended to `memory/rules.md`
- **Infrastructure Learnings** → appended to `MEMORY.md`

Only writes if the LLM finds genuinely new learnings. Skips trivial sessions.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "self-improvement": {
          "enabled": true,
          "messages": 30
        }
      }
    }
  }
}
```
