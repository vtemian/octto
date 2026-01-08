# octto

An interactive browser UI for AI brainstorming. Stop typing in terminals. Start clicking in browsers.

## The Problem

AI brainstorming today happens in the terminal:
```
Agent: What framework do you want?
You: *types* React
Agent: *thinks for 10 seconds*
Agent: What about styling?
You: *types* Tailwind
Agent: *thinks*
...repeat for 10 minutes...
```

Slow. Tedious. One question at a time.

## The Solution

**A browser window with visual questions you can answer in seconds.**

When you describe your idea, octto opens an interactive UI:

- Click options instead of typing
- See all questions at once
- Answer in any order
- Watch follow-ups appear instantly
- Review the final plan visually

**10 minutes of terminal typing → 2 minutes of clicking.**

## Quick Start

Add to `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["octto"] }
```

Select the **octto** agent:

```
I want to add a caching layer to the API
```

A browser window opens. Click your answers. Done.

## The Interactive UI

### Rich Question Types

No more typing everything. Pick from 14 visual input types:

| Type | What You See |
|------|--------------|
| `pick_one` | Radio buttons |
| `pick_many` | Checkboxes |
| `confirm` | Yes/No buttons |
| `slider` | Draggable range |
| `rank` | Drag to reorder |
| `rate` | Star rating |
| `thumbs` | Thumbs up/down |
| `show_options` | Cards with pros/cons |
| `show_diff` | Side-by-side code diff |
| `ask_code` | Syntax-highlighted editor |
| `ask_text` | Text input (when needed) |
| `ask_image` | Image upload |
| `ask_file` | File upload |
| `emoji_react` | Emoji picker |

### Live Updates

- Questions appear as you answer previous ones
- Progress indicator shows remaining questions
- Completed answers visible for context
- Final plan rendered as reviewable sections

### Parallel Branches

Your request is split into 2-4 exploration branches. All initial questions appear at once:

```
         ┌─ Branch 1: [question card]
Request ─┼─ Branch 2: [question card]
         └─ Branch 3: [question card]
                ↓
        Answer any, in any order
```

Each branch goes as deep as needed. Some finish in 2 questions, others take 4.

## How It Works Behind the Scenes

### 3 Agents

| Agent | Job |
|-------|-----|
| **bootstrapper** | Splits your request into branches |
| **probe** | Decides if a branch needs more questions |
| **octto** | Orchestrates the session |

### The Flow

1. Bootstrapper creates 2-4 branches from your request
2. Each branch gets an initial question → all shown in browser
3. You answer (click, not type)
4. Probe agent evaluates: more questions or done?
5. Repeat until all branches complete
6. Final plan shown for approval
7. Design saved to `docs/plans/`

## Configuration

Optional `~/.config/opencode/octto.json`:

```json
{
  "agents": {
    "probe": { "model": "anthropic/claude-sonnet-4" }
  }
}
```

## Development

```bash
bun install
bun run build
bun test
```

## License

MIT
