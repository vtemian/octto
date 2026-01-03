# brainstormer

> **Experimental** - This plugin is under active development.

An OpenCode plugin that turns rough ideas into fully-formed designs through collaborative dialogue with a browser-based UI.

## What It Does

The brainstormer agent guides you through design exploration:
1. Opens a browser window for interactive input
2. Asks structured questions (single choice, multiple choice, text input, etc.)
3. Adapts follow-up questions based on your answers
4. Produces a design document
5. Hands off to the planner for implementation

Instead of typing answers in the terminal, you respond through a visual UI with buttons, checkboxes, and text fields.

## Install

Add to your OpenCode config:

```json
{
  "plugin": ["/path/to/brainstormer"]
}
```

## Usage

Select the **brainstormer** agent in OpenCode, then describe your idea:

```
I want to add a caching layer to the API
```

The agent will:
1. Immediately open a browser with initial questions
2. Ask follow-up questions based on your answers
3. Continue until the design is sufficiently explored
4. Write the design to `thoughts/shared/designs/`

## Architecture

The plugin uses a multi-agent architecture for faster perceived startup:

| Agent | Role |
|-------|------|
| **brainstormer** | Orchestrator - coordinates flow, manages session |
| **bootstrapper** | Generates 2-3 fast initial questions |
| **probe** | Generates thoughtful follow-ups based on context |

```
User Request
     │
     ▼
brainstormer (orchestrator)
     │
     ├──► bootstrapper → [q1, q2, q3]
     │                        │
     │                   start_session
     │
     └──► LOOP:
              get_next_answer
                   │
                   ▼
              probe (with full Q&A context)
                   │
                   ▼
              {done?, question}
                   │
              push question (repeat until done)
                   │
              end_session → write design doc
```

## Question Types

The browser UI supports:

| Type | Use Case |
|------|----------|
| `pick_one` | Choose ONE option |
| `pick_many` | Select MULTIPLE options |
| `confirm` | Yes/No decisions |
| `ask_text` | Free-form text |
| `show_options` | Options with pros/cons |
| `review_section` | Validate content sections |
| `show_plan` | Full document review |
| `rank` | Order items by priority |
| `rate` | Score items on a scale |
| `thumbs` | Quick up/down feedback |
| `slider` | Numeric range input |

## Design Output

Designs are written to:
```
thoughts/shared/designs/YYYY-MM-DD-{topic}-design.md
```

## Development

```bash
bun install
bun test
bun run build
```

### Project Structure

```
src/
├── index.ts              # Plugin entry point
├── agents/
│   ├── brainstormer.ts   # Orchestrator agent
│   ├── bootstrapper.ts   # Fast initial questions
│   ├── probe.ts          # Thoughtful follow-ups
│   └── context.ts        # Q&A context builder
├── session/
│   ├── manager.ts        # Session lifecycle
│   ├── server.ts         # HTTP/WebSocket server
│   └── browser.ts        # Browser opener
├── tools/
│   ├── session.ts        # start_session, end_session
│   ├── questions.ts      # Question type tools
│   └── responses.ts      # get_answer, list_questions
└── ui/
    └── bundle.ts         # Browser UI
```

## License

MIT
