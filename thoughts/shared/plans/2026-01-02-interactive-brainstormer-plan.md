# Interactive Brainstormer Implementation Plan

**Goal:** Complete the OpenCode plugin that provides browser-based interactive UI tools for agents to gather user input through questions, selections, and feedback.

**Architecture:** WebSocket-based plugin with session management, HTTP server serving a bundled React app, and 16 question type tools. The agent controls the session lifecycle, pushes questions asynchronously, and retrieves responses via blocking or non-blocking calls.

**Design:** [thoughts/shared/designs/2026-01-02-interactive-brainstormer-design.md](../designs/2026-01-02-interactive-brainstormer-design.md)

---

## Current State

The following components are **already implemented**:
- `src/session/manager.ts` - SessionManager class with full lifecycle management
- `src/session/server.ts` - Bun HTTP/WebSocket server
- `src/session/browser.ts` - Cross-platform browser opener
- `src/session/types.ts` - Session, Question, WebSocket message types
- `src/types.ts` - All 16 question config and response types
- `package.json`, `tsconfig.json`, `biome.json` - Project configuration

**Missing components:**
1. Plugin entry point (`src/index.ts`)
2. Tool definitions for all 21 tools
3. UI bundle (`src/ui/bundle.ts` and React app)
4. Tests for session manager and tools
5. Event handling for OpenCode session cleanup

---

## Task 0: Review and Fix Existing Implementation

**Priority:** HIGH - Must be done before any new code

The existing implementation has several bugs and issues that need to be fixed before proceeding.

### Issue 0.1: Missing UI Bundle Import (Build Blocker)

**File:** `src/session/server.ts` line 4

**Problem:** Imports `getHtmlBundle` from `../ui/bundle` which doesn't exist. This prevents the project from building.

**Fix:** Create `src/ui/bundle.ts` first (Task 5 moved earlier), OR temporarily stub the import.

### Issue 0.2: Cancel Question Notifies Waiters Incorrectly

**File:** `src/session/manager.ts` lines 247-250

**Problem:** When cancelling a question, the code notifies waiters with `undefined`:
```typescript
const waiters = this.responseWaiters.get(questionId) || [];
for (const waiter of waiters) {
  waiter(undefined);  // BUG: This causes get_answer to return completed: true
}
```

The waiter callback (line 206-212) resolves with `completed: true, status: "answered"` regardless of the value:
```typescript
const waiterCallback = (response: unknown) => {
  clearTimeout(timeoutId);
  resolve({
    completed: true,  // Always true!
    status: "answered",
    response,
  });
};
```

**Fix:** Change the waiter pattern to handle cancellation:

```typescript
// In cancelQuestion method (around line 247):
const waiters = this.responseWaiters.get(questionId) || [];
for (const waiter of waiters) {
  waiter({ cancelled: true });  // Signal cancellation
}

// In getAnswer method, update waiterCallback (around line 206):
const waiterCallback = (response: unknown) => {
  clearTimeout(timeoutId);
  if (response && typeof response === 'object' && 'cancelled' in response) {
    resolve({
      completed: false,
      status: "cancelled",
      reason: "cancelled",
    });
  } else {
    resolve({
      completed: true,
      status: "answered",
      response,
    });
  }
};
```

### Issue 0.3: YAGNI Violation - Extra Types Not in Design

**File:** `src/types.ts` lines 208-250

**Problem:** Contains `WizardStep`, `WizardConfig`, `InterviewQuestion`, `InterviewConfig` types that are NOT in the design document's 16 question types. These add complexity without being used.

**Fix:** Remove these types:
- Delete `WizardStep` interface (lines 208-215)
- Delete `WizardConfig` interface (lines 217-224)
- Delete `InterviewQuestion` interface (lines 226-241)
- Delete `InterviewConfig` interface (lines 243-250)
- Delete `WizardResponse` interface (lines 406-411)
- Delete `InterviewResponse` interface (lines 413-420)

### Issue 0.4: Type Import at End of File

**File:** `src/session/types.ts` line 135

**Problem:** The `ServerWebSocket` type is imported at the bottom of the file after it's used on line 61. While TypeScript allows this due to hoisting, it's confusing and non-standard.

**Fix:** Move the import to the top of the file:
```typescript
// At top of file, after the first comment
import type { ServerWebSocket } from "bun";
```

### Verification Steps for Task 0

After making all fixes:

1. Run `bun run typecheck` - should pass with no errors
2. Run `bun run build` - will still fail (missing ui/bundle) but should have no type errors
3. Verify `src/types.ts` no longer contains Wizard/Interview types
4. Verify `src/session/types.ts` has import at top

---

## Task 1: Create UI Bundle (Moved Up - Build Dependency)

**Files:**
- Create: `src/ui/bundle.ts`

**Why moved up:** The server.ts file imports from `../ui/bundle`, so this must exist before the project can build.

**Step 1: Create placeholder HTML bundle**

The React UI will be built separately and embedded as a string. For now, create a minimal working placeholder that handles the core question types:

```typescript
// src/ui/bundle.ts

/**
 * Returns the bundled HTML for the brainstormer UI.
 * This is a pre-built React app embedded as a string.
 * 
 * The UI connects via WebSocket and renders questions as they arrive.
 */
export function getHtmlBundle(): string {
  // See Task 5 in original plan for full implementation
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Brainstormer</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 min-h-screen p-8">
  <div id="root" class="max-w-2xl mx-auto">
    <div class="text-center py-12">
      <h1 class="text-2xl font-bold text-gray-800 mb-4">Brainstormer</h1>
      <p class="text-gray-600 mb-8">Connecting...</p>
    </div>
  </div>
  <script>
    // Minimal WebSocket client - full implementation in Task 5
    const ws = new WebSocket('ws://' + location.host + '/ws');
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connected' }));
    ws.onmessage = (e) => console.log('Message:', JSON.parse(e.data));
  </script>
</body>
</html>`;
}
```

**Step 2: Verify build now works**

Run: `bun run typecheck`
Expected: PASS (no type errors)

Run: `bun run build`
Expected: Build succeeds (creates dist/index.js)

---

## Task 2: Create Plugin Entry Point

**Files:**
- Create: `src/index.ts`

**Step 1: Write the plugin entry point**

```typescript
// src/index.ts
import type { Plugin } from "@opencode-ai/plugin";
import { SessionManager } from "./session/manager";
import { createBrainstormerTools } from "./tools";

const BrainstormerPlugin: Plugin = async (ctx) => {
  // Create session manager
  const sessionManager = new SessionManager();

  // Create all tools
  const tools = createBrainstormerTools(sessionManager);

  return {
    tool: tools,

    event: async ({ event }) => {
      // Cleanup sessions when OpenCode session is deleted
      if (event.type === "session.deleted") {
        await sessionManager.cleanup();
      }
    },
  };
};

export default BrainstormerPlugin;

// Re-export types for consumers
export type * from "./types";
```

**Step 2: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: Error about missing `./tools` module (expected, we'll create it next)

---

## Task 3: Create Tool Definitions - Session Management

**Files:**
- Create: `src/tools/index.ts`
- Create: `src/tools/session.ts`

**Step 1: Create session management tools**

```typescript
// src/tools/session.ts
import { tool } from "@opencode-ai/plugin/tool";
import type { SessionManager } from "../session/manager";

export function createSessionTools(manager: SessionManager) {
  const start_session = tool({
    description: `Start an interactive brainstormer session.
Opens a browser window for the user to answer questions.
Returns session_id and URL. Use question tools to push questions.`,
    args: {
      title: tool.schema.string().optional().describe("Session title (shown in browser)"),
    },
    execute: async (args) => {
      try {
        const result = await manager.startSession({ title: args.title });
        return `## Session Started

| Field | Value |
|-------|-------|
| Session ID | ${result.session_id} |
| URL | ${result.url} |

Browser opened. Use question tools (pick_one, confirm, etc.) to push questions.
Use get_answer to retrieve responses.`;
      } catch (error) {
        return `Failed to start session: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const end_session = tool({
    description: `End an interactive brainstormer session.
Closes the browser window and cleans up resources.`,
    args: {
      session_id: tool.schema.string().describe("Session ID to end"),
    },
    execute: async (args) => {
      const result = await manager.endSession(args.session_id);
      if (result.ok) {
        return `Session ${args.session_id} ended successfully.`;
      }
      return `Failed to end session ${args.session_id}. It may not exist.`;
    },
  });

  return { start_session, end_session };
}
```

**Step 2: Create tools index that combines all tools**

```typescript
// src/tools/index.ts
import type { SessionManager } from "../session/manager";
import { createSessionTools } from "./session";
import { createQuestionTools } from "./questions";
import { createResponseTools } from "./responses";

export function createBrainstormerTools(manager: SessionManager) {
  return {
    ...createSessionTools(manager),
    ...createQuestionTools(manager),
    ...createResponseTools(manager),
  };
}
```

**Step 3: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: Errors about missing `./questions` and `./responses` modules

---

## Task 4: Create Tool Definitions - Question Tools

**Files:**
- Create: `src/tools/questions.ts`

**Step 1: Create decision/choice question tools**

```typescript
// src/tools/questions.ts
import { tool } from "@opencode-ai/plugin/tool";
import type { SessionManager } from "../session/manager";
import type {
  PickOneConfig,
  PickManyConfig,
  ConfirmConfig,
  RankConfig,
  RateConfig,
} from "../types";

// Helper to get active session ID (assumes single session for now)
function getActiveSessionId(manager: SessionManager): string {
  const sessions = manager.listQuestions();
  if (sessions.questions.length === 0) {
    throw new Error("No active session. Call start_session first.");
  }
  // Get session from first question, or we need to track active session
  // For now, we'll require session_id in each call
  throw new Error("session_id is required");
}

export function createQuestionTools(manager: SessionManager) {
  const pick_one = tool({
    description: `Ask user to select ONE option from a list.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      options: tool.schema
        .array(
          tool.schema.object({
            id: tool.schema.string().describe("Unique option identifier"),
            label: tool.schema.string().describe("Display label"),
            description: tool.schema.string().optional().describe("Optional description"),
          })
        )
        .describe("Available options"),
      recommended: tool.schema.string().optional().describe("Recommended option id (highlighted)"),
      allowOther: tool.schema.boolean().optional().describe("Allow custom 'other' input"),
    },
    execute: async (args) => {
      try {
        const config: PickOneConfig = {
          question: args.question,
          options: args.options,
          recommended: args.recommended,
          allowOther: args.allowOther,
        };
        const result = manager.pushQuestion(args.session_id, "pick_one", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const pick_many = tool({
    description: `Ask user to select MULTIPLE options from a list.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      options: tool.schema
        .array(
          tool.schema.object({
            id: tool.schema.string().describe("Unique option identifier"),
            label: tool.schema.string().describe("Display label"),
            description: tool.schema.string().optional().describe("Optional description"),
          })
        )
        .describe("Available options"),
      recommended: tool.schema.array(tool.schema.string()).optional().describe("Recommended option ids"),
      min: tool.schema.number().optional().describe("Minimum selections required"),
      max: tool.schema.number().optional().describe("Maximum selections allowed"),
      allowOther: tool.schema.boolean().optional().describe("Allow custom 'other' input"),
    },
    execute: async (args) => {
      try {
        const config: PickManyConfig = {
          question: args.question,
          options: args.options,
          recommended: args.recommended,
          min: args.min,
          max: args.max,
          allowOther: args.allowOther,
        };
        const result = manager.pushQuestion(args.session_id, "pick_many", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const confirm = tool({
    description: `Ask user for Yes/No confirmation.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      context: tool.schema.string().optional().describe("Additional context/details"),
      yesLabel: tool.schema.string().optional().describe("Custom label for yes button"),
      noLabel: tool.schema.string().optional().describe("Custom label for no button"),
      allowCancel: tool.schema.boolean().optional().describe("Show cancel option"),
    },
    execute: async (args) => {
      try {
        const config: ConfirmConfig = {
          question: args.question,
          context: args.context,
          yesLabel: args.yesLabel,
          noLabel: args.noLabel,
          allowCancel: args.allowCancel,
        };
        const result = manager.pushQuestion(args.session_id, "confirm", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const rank = tool({
    description: `Ask user to rank/order items by dragging.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      options: tool.schema
        .array(
          tool.schema.object({
            id: tool.schema.string().describe("Unique option identifier"),
            label: tool.schema.string().describe("Display label"),
            description: tool.schema.string().optional().describe("Optional description"),
          })
        )
        .describe("Items to rank"),
      context: tool.schema.string().optional().describe("Instructions/context"),
    },
    execute: async (args) => {
      try {
        const config: RankConfig = {
          question: args.question,
          options: args.options,
          context: args.context,
        };
        const result = manager.pushQuestion(args.session_id, "rank", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const rate = tool({
    description: `Ask user to rate items on a numeric scale.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      options: tool.schema
        .array(
          tool.schema.object({
            id: tool.schema.string().describe("Unique option identifier"),
            label: tool.schema.string().describe("Display label"),
            description: tool.schema.string().optional().describe("Optional description"),
          })
        )
        .describe("Items to rate"),
      min: tool.schema.number().optional().describe("Minimum rating value (default: 1)"),
      max: tool.schema.number().optional().describe("Maximum rating value (default: 5)"),
      step: tool.schema.number().optional().describe("Rating step (default: 1)"),
    },
    execute: async (args) => {
      try {
        const config: RateConfig = {
          question: args.question,
          options: args.options,
          min: args.min,
          max: args.max,
          step: args.step,
        };
        const result = manager.pushQuestion(args.session_id, "rate", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  // Import remaining tools from other files
  const inputTools = createInputTools(manager);
  const presentationTools = createPresentationTools(manager);
  const quickTools = createQuickTools(manager);

  return {
    pick_one,
    pick_many,
    confirm,
    rank,
    rate,
    ...inputTools,
    ...presentationTools,
    ...quickTools,
  };
}

// Input tools (ask_text, ask_image, ask_file, ask_code)
function createInputTools(manager: SessionManager) {
  const ask_text = tool({
    description: `Ask user for text input (single or multi-line).
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      placeholder: tool.schema.string().optional().describe("Placeholder text"),
      context: tool.schema.string().optional().describe("Instructions/context"),
      multiline: tool.schema.boolean().optional().describe("Multi-line input (default: false)"),
      minLength: tool.schema.number().optional().describe("Minimum text length"),
      maxLength: tool.schema.number().optional().describe("Maximum text length"),
    },
    execute: async (args) => {
      try {
        const config = {
          question: args.question,
          placeholder: args.placeholder,
          context: args.context,
          multiline: args.multiline,
          minLength: args.minLength,
          maxLength: args.maxLength,
        };
        const result = manager.pushQuestion(args.session_id, "ask_text", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const ask_image = tool({
    description: `Ask user to upload/paste image(s).
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      context: tool.schema.string().optional().describe("Instructions/context"),
      multiple: tool.schema.boolean().optional().describe("Allow multiple images"),
      maxImages: tool.schema.number().optional().describe("Maximum number of images"),
    },
    execute: async (args) => {
      try {
        const config = {
          question: args.question,
          context: args.context,
          multiple: args.multiple,
          maxImages: args.maxImages,
        };
        const result = manager.pushQuestion(args.session_id, "ask_image", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const ask_file = tool({
    description: `Ask user to upload file(s).
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      context: tool.schema.string().optional().describe("Instructions/context"),
      multiple: tool.schema.boolean().optional().describe("Allow multiple files"),
      maxFiles: tool.schema.number().optional().describe("Maximum number of files"),
      accept: tool.schema.array(tool.schema.string()).optional().describe("Allowed file types"),
      maxSize: tool.schema.number().optional().describe("Maximum file size in bytes"),
    },
    execute: async (args) => {
      try {
        const config = {
          question: args.question,
          context: args.context,
          multiple: args.multiple,
          maxFiles: args.maxFiles,
          accept: args.accept,
          maxSize: args.maxSize,
        };
        const result = manager.pushQuestion(args.session_id, "ask_file", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const ask_code = tool({
    description: `Ask user for code input with syntax highlighting.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      context: tool.schema.string().optional().describe("Instructions/context"),
      language: tool.schema.string().optional().describe("Programming language for highlighting"),
      placeholder: tool.schema.string().optional().describe("Placeholder code"),
    },
    execute: async (args) => {
      try {
        const config = {
          question: args.question,
          context: args.context,
          language: args.language,
          placeholder: args.placeholder,
        };
        const result = manager.pushQuestion(args.session_id, "ask_code", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  return { ask_text, ask_image, ask_file, ask_code };
}

// Presentation/Feedback tools (show_diff, show_plan, show_options, review_section)
function createPresentationTools(manager: SessionManager) {
  const show_diff = tool({
    description: `Show a diff and ask user to approve/reject/edit.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Title/description of the change"),
      before: tool.schema.string().describe("Original content"),
      after: tool.schema.string().describe("Modified content"),
      filePath: tool.schema.string().optional().describe("File path for context"),
      language: tool.schema.string().optional().describe("Language for syntax highlighting"),
    },
    execute: async (args) => {
      try {
        const config = {
          question: args.question,
          before: args.before,
          after: args.after,
          filePath: args.filePath,
          language: args.language,
        };
        const result = manager.pushQuestion(args.session_id, "show_diff", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const show_plan = tool({
    description: `Show a plan/document for user review with annotations.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Plan title"),
      sections: tool.schema
        .array(
          tool.schema.object({
            id: tool.schema.string().describe("Section identifier"),
            title: tool.schema.string().describe("Section title"),
            content: tool.schema.string().describe("Section content (markdown)"),
          })
        )
        .optional()
        .describe("Plan sections"),
      markdown: tool.schema.string().optional().describe("Full markdown (alternative to sections)"),
    },
    execute: async (args) => {
      try {
        const config = {
          question: args.question,
          sections: args.sections || [],
          markdown: args.markdown,
        };
        const result = manager.pushQuestion(args.session_id, "show_plan", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const show_options = tool({
    description: `Show options with pros/cons for user to select.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      options: tool.schema
        .array(
          tool.schema.object({
            id: tool.schema.string().describe("Unique option identifier"),
            label: tool.schema.string().describe("Display label"),
            description: tool.schema.string().optional().describe("Optional description"),
            pros: tool.schema.array(tool.schema.string()).optional().describe("Advantages"),
            cons: tool.schema.array(tool.schema.string()).optional().describe("Disadvantages"),
          })
        )
        .describe("Options with pros/cons"),
      recommended: tool.schema.string().optional().describe("Recommended option id"),
      allowFeedback: tool.schema.boolean().optional().describe("Allow text feedback with selection"),
    },
    execute: async (args) => {
      try {
        const config = {
          question: args.question,
          options: args.options,
          recommended: args.recommended,
          allowFeedback: args.allowFeedback,
        };
        const result = manager.pushQuestion(args.session_id, "show_options", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const review_section = tool({
    description: `Show content section for user review with inline feedback.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Section title"),
      content: tool.schema.string().describe("Section content (markdown)"),
      context: tool.schema.string().optional().describe("Context about what to review"),
    },
    execute: async (args) => {
      try {
        const config = {
          question: args.question,
          content: args.content,
          context: args.context,
        };
        const result = manager.pushQuestion(args.session_id, "review_section", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  return { show_diff, show_plan, show_options, review_section };
}

// Quick tools (thumbs, emoji_react, slider)
function createQuickTools(manager: SessionManager) {
  const thumbs = tool({
    description: `Ask user for quick thumbs up/down feedback.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      context: tool.schema.string().optional().describe("Context to show"),
    },
    execute: async (args) => {
      try {
        const config = {
          question: args.question,
          context: args.context,
        };
        const result = manager.pushQuestion(args.session_id, "thumbs", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const emoji_react = tool({
    description: `Ask user to react with an emoji.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      context: tool.schema.string().optional().describe("Context to show"),
      emojis: tool.schema.array(tool.schema.string()).optional().describe("Available emoji options"),
    },
    execute: async (args) => {
      try {
        const config = {
          question: args.question,
          context: args.context,
          emojis: args.emojis,
        };
        const result = manager.pushQuestion(args.session_id, "emoji_react", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  const slider = tool({
    description: `Ask user to select a value on a numeric slider.
Returns immediately with question_id. Use get_answer to retrieve response.`,
    args: {
      session_id: tool.schema.string().describe("Session ID from start_session"),
      question: tool.schema.string().describe("Question to display"),
      min: tool.schema.number().describe("Minimum value"),
      max: tool.schema.number().describe("Maximum value"),
      step: tool.schema.number().optional().describe("Step size (default: 1)"),
      defaultValue: tool.schema.number().optional().describe("Default value"),
      context: tool.schema.string().optional().describe("Instructions/context"),
    },
    execute: async (args) => {
      try {
        const config = {
          question: args.question,
          min: args.min,
          max: args.max,
          step: args.step,
          defaultValue: args.defaultValue,
          context: args.context,
        };
        const result = manager.pushQuestion(args.session_id, "slider", config);
        return `Question pushed: ${result.question_id}\nUse get_answer("${result.question_id}") to retrieve response.`;
      } catch (error) {
        return `Failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });

  return { thumbs, emoji_react, slider };
}
```

**Step 2: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: Error about missing `./responses` module

---

## Task 5: Create Tool Definitions - Response Tools

**Files:**
- Create: `src/tools/responses.ts`

**Step 1: Create response retrieval tools**

```typescript
// src/tools/responses.ts
import { tool } from "@opencode-ai/plugin/tool";
import type { SessionManager } from "../session/manager";

export function createResponseTools(manager: SessionManager) {
  const get_answer = tool({
    description: `Get the answer to a question.
By default returns immediately with current status.
Set block=true to wait for user response (with optional timeout).`,
    args: {
      question_id: tool.schema.string().describe("Question ID from a question tool"),
      block: tool.schema.boolean().optional().describe("Wait for response (default: false)"),
      timeout: tool.schema.number().optional().describe("Max milliseconds to wait if blocking (default: 300000 = 5 min)"),
    },
    execute: async (args) => {
      const result = await manager.getAnswer({
        question_id: args.question_id,
        block: args.block,
        timeout: args.timeout,
      });

      if (result.completed) {
        return `## Answer Received

**Status:** ${result.status}

**Response:**
\`\`\`json
${JSON.stringify(result.response, null, 2)}
\`\`\``;
      }

      return `## Waiting for Answer

**Status:** ${result.status}
**Reason:** ${result.reason}

${result.status === "pending" ? "User has not answered yet. Call again with block=true to wait." : ""}`;
    },
  });

  const list_questions = tool({
    description: `List all questions and their status for a session.`,
    args: {
      session_id: tool.schema.string().optional().describe("Session ID (omit for all sessions)"),
    },
    execute: async (args) => {
      const result = manager.listQuestions(args.session_id);

      if (result.questions.length === 0) {
        return "No questions found.";
      }

      let output = "## Questions\n\n";
      output += "| ID | Type | Status | Created | Answered |\n";
      output += "|----|------|--------|---------|----------|\n";

      for (const q of result.questions) {
        output += `| ${q.id} | ${q.type} | ${q.status} | ${q.createdAt} | ${q.answeredAt || "-"} |\n`;
      }

      return output;
    },
  });

  const cancel_question = tool({
    description: `Cancel a pending question.
The question will be removed from the user's queue.`,
    args: {
      question_id: tool.schema.string().describe("Question ID to cancel"),
    },
    execute: async (args) => {
      const result = manager.cancelQuestion(args.question_id);
      if (result.ok) {
        return `Question ${args.question_id} cancelled.`;
      }
      return `Could not cancel question ${args.question_id}. It may already be answered or not exist.`;
    },
  });

  return { get_answer, list_questions, cancel_question };
}
```

**Step 2: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: PASS (ui/bundle.ts was created in Task 1)

---

## Task 6: Expand UI Bundle with Full Question Rendering

**Files:**
- Modify: `src/ui/bundle.ts`

**Step 1: Replace minimal placeholder with full implementation**

Update the placeholder from Task 1 with the full question rendering logic:

```typescript
// src/ui/bundle.ts

/**
 * Returns the bundled HTML for the brainstormer UI.
 * This is a pre-built React app embedded as a string.
 * 
 * The UI connects via WebSocket and renders questions as they arrive.
 */
export function getHtmlBundle(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Brainstormer</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; }
    .card { @apply bg-white rounded-lg shadow-md p-6 mb-4; }
  </style>
</head>
<body class="bg-gray-100 min-h-screen p-8">
  <div id="root" class="max-w-2xl mx-auto">
    <div class="text-center py-12">
      <h1 class="text-2xl font-bold text-gray-800 mb-4">Brainstormer</h1>
      <p class="text-gray-600 mb-8">Connecting to session...</p>
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
    </div>
  </div>
  
  <script>
    const wsUrl = 'ws://' + window.location.host + '/ws';
    let ws = null;
    let questions = [];
    let currentIndex = 0;
    
    function connect() {
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        console.log('Connected to brainstormer');
        ws.send(JSON.stringify({ type: 'connected' }));
        render();
      };
      
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        console.log('Received:', msg);
        
        if (msg.type === 'question') {
          questions.push(msg);
          render();
        } else if (msg.type === 'cancel') {
          questions = questions.filter(q => q.id !== msg.id);
          render();
        } else if (msg.type === 'end') {
          document.getElementById('root').innerHTML = 
            '<div class="text-center py-12"><h1 class="text-2xl font-bold text-gray-800">Session Ended</h1><p class="text-gray-600 mt-4">You can close this window.</p></div>';
        }
      };
      
      ws.onclose = () => {
        console.log('Disconnected, reconnecting in 2s...');
        setTimeout(connect, 2000);
      };
    }
    
    function render() {
      const root = document.getElementById('root');
      
      if (questions.length === 0) {
        root.innerHTML = '<div class="text-center py-12"><h1 class="text-2xl font-bold text-gray-800 mb-4">Brainstormer</h1><p class="text-gray-600">Waiting for questions...</p></div>';
        return;
      }
      
      const pending = questions.filter(q => !q.answered);
      const answered = questions.filter(q => q.answered);
      
      let html = '';
      
      // Show answered questions (collapsed)
      for (const q of answered) {
        html += '<div class="bg-green-50 border border-green-200 rounded-lg p-4 mb-2 opacity-75">';
        html += '<div class="flex items-center gap-2">';
        html += '<svg class="w-5 h-5 text-green-600" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>';
        html += '<span class="text-green-800 font-medium">' + escapeHtml(q.config.question) + '</span>';
        html += '</div></div>';
      }
      
      // Show current question
      if (pending.length > 0) {
        const q = pending[0];
        html += renderQuestion(q);
        
        // Show queue indicator
        if (pending.length > 1) {
          html += '<div class="text-center text-gray-500 text-sm mt-4">' + (pending.length - 1) + ' more question(s) in queue</div>';
        }
      }
      
      root.innerHTML = html;
      
      // Attach event listeners
      attachListeners();
    }
    
    function renderQuestion(q) {
      const config = q.config;
      let html = '<div class="bg-white rounded-lg shadow-lg p-6 mb-4">';
      html += '<h2 class="text-lg font-semibold text-gray-800 mb-4">' + escapeHtml(config.question) + '</h2>';
      
      switch (q.questionType) {
        case 'pick_one':
          html += renderPickOne(q);
          break;
        case 'pick_many':
          html += renderPickMany(q);
          break;
        case 'confirm':
          html += renderConfirm(q);
          break;
        case 'ask_text':
          html += renderAskText(q);
          break;
        case 'thumbs':
          html += renderThumbs(q);
          break;
        case 'slider':
          html += renderSlider(q);
          break;
        default:
          html += '<p class="text-gray-600">Question type "' + q.questionType + '" not yet implemented.</p>';
          html += '<button onclick="submitAnswer(\\'' + q.id + '\\', {})" class="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Skip</button>';
      }
      
      html += '</div>';
      return html;
    }
    
    function renderPickOne(q) {
      const options = q.config.options || [];
      let html = '<div class="space-y-2">';
      for (const opt of options) {
        const isRecommended = q.config.recommended === opt.id;
        html += '<label class="flex items-start gap-3 p-3 border rounded-lg cursor-pointer hover:bg-gray-50' + (isRecommended ? ' border-blue-300 bg-blue-50' : '') + '">';
        html += '<input type="radio" name="pick_' + q.id + '" value="' + opt.id + '" class="mt-1">';
        html += '<div>';
        html += '<div class="font-medium">' + escapeHtml(opt.label) + (isRecommended ? ' <span class="text-blue-600 text-sm">(recommended)</span>' : '') + '</div>';
        if (opt.description) html += '<div class="text-sm text-gray-600">' + escapeHtml(opt.description) + '</div>';
        html += '</div></label>';
      }
      html += '</div>';
      html += '<button onclick="submitPickOne(\\'' + q.id + '\\')" class="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Submit</button>';
      return html;
    }
    
    function renderPickMany(q) {
      const options = q.config.options || [];
      let html = '<div class="space-y-2">';
      for (const opt of options) {
        html += '<label class="flex items-start gap-3 p-3 border rounded-lg cursor-pointer hover:bg-gray-50">';
        html += '<input type="checkbox" name="pick_' + q.id + '" value="' + opt.id + '" class="mt-1">';
        html += '<div>';
        html += '<div class="font-medium">' + escapeHtml(opt.label) + '</div>';
        if (opt.description) html += '<div class="text-sm text-gray-600">' + escapeHtml(opt.description) + '</div>';
        html += '</div></label>';
      }
      html += '</div>';
      html += '<button onclick="submitPickMany(\\'' + q.id + '\\')" class="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Submit</button>';
      return html;
    }
    
    function renderConfirm(q) {
      const yesLabel = q.config.yesLabel || 'Yes';
      const noLabel = q.config.noLabel || 'No';
      let html = '';
      if (q.config.context) {
        html += '<p class="text-gray-600 mb-4">' + escapeHtml(q.config.context) + '</p>';
      }
      html += '<div class="flex gap-3">';
      html += '<button onclick="submitAnswer(\\'' + q.id + '\\', {choice: \\'yes\\'})" class="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700">' + escapeHtml(yesLabel) + '</button>';
      html += '<button onclick="submitAnswer(\\'' + q.id + '\\', {choice: \\'no\\'})" class="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">' + escapeHtml(noLabel) + '</button>';
      if (q.config.allowCancel) {
        html += '<button onclick="submitAnswer(\\'' + q.id + '\\', {choice: \\'cancel\\'})" class="px-4 py-2 bg-gray-400 text-white rounded hover:bg-gray-500">Cancel</button>';
      }
      html += '</div>';
      return html;
    }
    
    function renderAskText(q) {
      const multiline = q.config.multiline;
      let html = '';
      if (q.config.context) {
        html += '<p class="text-gray-600 mb-4">' + escapeHtml(q.config.context) + '</p>';
      }
      if (multiline) {
        html += '<textarea id="text_' + q.id + '" class="w-full p-3 border rounded-lg" rows="4" placeholder="' + escapeHtml(q.config.placeholder || '') + '"></textarea>';
      } else {
        html += '<input type="text" id="text_' + q.id + '" class="w-full p-3 border rounded-lg" placeholder="' + escapeHtml(q.config.placeholder || '') + '">';
      }
      html += '<button onclick="submitText(\\'' + q.id + '\\')" class="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Submit</button>';
      return html;
    }
    
    function renderThumbs(q) {
      let html = '';
      if (q.config.context) {
        html += '<p class="text-gray-600 mb-4">' + escapeHtml(q.config.context) + '</p>';
      }
      html += '<div class="flex gap-4">';
      html += '<button onclick="submitAnswer(\\'' + q.id + '\\', {choice: \\'up\\'})" class="p-4 text-4xl hover:bg-green-100 rounded-lg">\\uD83D\\uDC4D</button>';
      html += '<button onclick="submitAnswer(\\'' + q.id + '\\', {choice: \\'down\\'})" class="p-4 text-4xl hover:bg-red-100 rounded-lg">\\uD83D\\uDC4E</button>';
      html += '</div>';
      return html;
    }
    
    function renderSlider(q) {
      const min = q.config.min;
      const max = q.config.max;
      const step = q.config.step || 1;
      const defaultVal = q.config.defaultValue || Math.floor((min + max) / 2);
      let html = '';
      if (q.config.context) {
        html += '<p class="text-gray-600 mb-4">' + escapeHtml(q.config.context) + '</p>';
      }
      html += '<div class="flex items-center gap-4">';
      html += '<span class="text-gray-600">' + min + '</span>';
      html += '<input type="range" id="slider_' + q.id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + defaultVal + '" class="flex-1">';
      html += '<span class="text-gray-600">' + max + '</span>';
      html += '<span id="slider_val_' + q.id + '" class="font-bold text-blue-600 w-12 text-center">' + defaultVal + '</span>';
      html += '</div>';
      html += '<button onclick="submitSlider(\\'' + q.id + '\\')" class="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Submit</button>';
      return html;
    }
    
    function attachListeners() {
      // Attach slider value display
      document.querySelectorAll('input[type="range"]').forEach(slider => {
        const id = slider.id.replace('slider_', 'slider_val_');
        slider.oninput = () => {
          document.getElementById(id).textContent = slider.value;
        };
      });
    }
    
    function submitAnswer(questionId, answer) {
      const q = questions.find(q => q.id === questionId);
      if (q) {
        q.answered = true;
        ws.send(JSON.stringify({ type: 'response', id: questionId, answer }));
        render();
      }
    }
    
    function submitPickOne(questionId) {
      const selected = document.querySelector('input[name="pick_' + questionId + '"]:checked');
      if (selected) {
        submitAnswer(questionId, { selected: selected.value });
      }
    }
    
    function submitPickMany(questionId) {
      const selected = Array.from(document.querySelectorAll('input[name="pick_' + questionId + '"]:checked')).map(el => el.value);
      submitAnswer(questionId, { selected });
    }
    
    function submitText(questionId) {
      const input = document.getElementById('text_' + questionId);
      if (input) {
        submitAnswer(questionId, { text: input.value });
      }
    }
    
    function submitSlider(questionId) {
      const slider = document.getElementById('slider_' + questionId);
      if (slider) {
        submitAnswer(questionId, { value: parseFloat(slider.value) });
      }
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    // Start connection
    connect();
  </script>
</body>
</html>`;
}
```

**Step 2: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: PASS (no errors)

**Step 3: Verify build works**

Run: `bun run build`
Expected: Build succeeds, creates `dist/index.js` and `dist/index.d.ts`

---

## Task 7: Write Session Manager Tests

**Files:**
- Create: `tests/session/manager.test.ts`

**Step 1: Write tests for session lifecycle**

```typescript
// tests/session/manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionManager } from "../../src/session/manager";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    await manager.cleanup();
  });

  describe("startSession", () => {
    it("should create a session with unique ID", async () => {
      const result = await manager.startSession({ title: "Test Session" });
      
      expect(result.session_id).toMatch(/^ses_[a-z0-9]{8}$/);
      expect(result.url).toMatch(/^http:\/\/localhost:\d+$/);
    });

    it("should create multiple sessions with different IDs", async () => {
      const result1 = await manager.startSession({});
      const result2 = await manager.startSession({});
      
      expect(result1.session_id).not.toBe(result2.session_id);
      expect(result1.url).not.toBe(result2.url);
    });
  });

  describe("endSession", () => {
    it("should end an existing session", async () => {
      const { session_id } = await manager.startSession({});
      
      const result = await manager.endSession(session_id);
      
      expect(result.ok).toBe(true);
    });

    it("should return ok=false for non-existent session", async () => {
      const result = await manager.endSession("ses_nonexistent");
      
      expect(result.ok).toBe(false);
    });
  });

  describe("pushQuestion", () => {
    it("should push a question and return question ID", async () => {
      const { session_id } = await manager.startSession({});
      
      const result = manager.pushQuestion(session_id, "pick_one", {
        question: "Test question",
        options: [{ id: "a", label: "Option A" }],
      });
      
      expect(result.question_id).toMatch(/^q_[a-z0-9]{8}$/);
    });

    it("should throw for non-existent session", async () => {
      expect(() => {
        manager.pushQuestion("ses_nonexistent", "pick_one", {
          question: "Test",
          options: [],
        });
      }).toThrow("Session not found");
    });
  });

  describe("getAnswer", () => {
    it("should return pending status for unanswered question", async () => {
      const { session_id } = await manager.startSession({});
      const { question_id } = manager.pushQuestion(session_id, "confirm", {
        question: "Test?",
      });
      
      const result = await manager.getAnswer({ question_id, block: false });
      
      expect(result.completed).toBe(false);
      expect(result.status).toBe("pending");
    });

    it("should return cancelled status for non-existent question", async () => {
      const result = await manager.getAnswer({ question_id: "q_nonexistent", block: false });
      
      expect(result.completed).toBe(false);
      expect(result.status).toBe("cancelled");
    });
  });

  describe("cancelQuestion", () => {
    it("should cancel a pending question", async () => {
      const { session_id } = await manager.startSession({});
      const { question_id } = manager.pushQuestion(session_id, "confirm", {
        question: "Test?",
      });
      
      const result = manager.cancelQuestion(question_id);
      
      expect(result.ok).toBe(true);
    });

    it("should return ok=false for non-existent question", () => {
      const result = manager.cancelQuestion("q_nonexistent");
      
      expect(result.ok).toBe(false);
    });
  });

  describe("listQuestions", () => {
    it("should list all questions across sessions", async () => {
      const { session_id } = await manager.startSession({});
      manager.pushQuestion(session_id, "confirm", { question: "Q1?" });
      manager.pushQuestion(session_id, "pick_one", { question: "Q2?", options: [] });
      
      const result = manager.listQuestions();
      
      expect(result.questions.length).toBe(2);
    });

    it("should filter by session ID", async () => {
      const { session_id: s1 } = await manager.startSession({});
      const { session_id: s2 } = await manager.startSession({});
      manager.pushQuestion(s1, "confirm", { question: "Q1?" });
      manager.pushQuestion(s2, "confirm", { question: "Q2?" });
      
      const result = manager.listQuestions(s1);
      
      expect(result.questions.length).toBe(1);
    });
  });
});
```

**Step 2: Run tests to verify they pass**

Run: `bun test tests/session/manager.test.ts`
Expected: All tests PASS

---

## Task 8: Write Tool Definition Tests

**Files:**
- Create: `tests/tools/session.test.ts`

**Step 1: Write tests for session tools**

```typescript
// tests/tools/session.test.ts
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { SessionManager } from "../../src/session/manager";
import { createSessionTools } from "../../src/tools/session";

describe("Session Tools", () => {
  let manager: SessionManager;
  let tools: ReturnType<typeof createSessionTools>;

  beforeEach(() => {
    manager = new SessionManager();
    tools = createSessionTools(manager);
  });

  afterEach(async () => {
    await manager.cleanup();
  });

  describe("start_session", () => {
    it("should start a session and return formatted output", async () => {
      const result = await tools.start_session.execute({ title: "Test" }, {} as any);
      
      expect(result).toContain("Session Started");
      expect(result).toContain("Session ID");
      expect(result).toContain("ses_");
    });
  });

  describe("end_session", () => {
    it("should end a session successfully", async () => {
      const startResult = await tools.start_session.execute({}, {} as any);
      const sessionId = startResult.match(/ses_[a-z0-9]+/)?.[0];
      
      const result = await tools.end_session.execute({ session_id: sessionId! }, {} as any);
      
      expect(result).toContain("ended successfully");
    });

    it("should handle non-existent session", async () => {
      const result = await tools.end_session.execute({ session_id: "ses_fake" }, {} as any);
      
      expect(result).toContain("Failed");
    });
  });
});
```

**Step 2: Run tests**

Run: `bun test tests/tools/session.test.ts`
Expected: All tests PASS

---

## Task 9: Add OpenCode Session Cleanup Hook

**Files:**
- Modify: `src/index.ts`

**Step 1: Update plugin to track sessions per OpenCode session**

```typescript
// src/index.ts - updated version
import type { Plugin } from "@opencode-ai/plugin";
import { SessionManager } from "./session/manager";
import { createBrainstormerTools } from "./tools";

const BrainstormerPlugin: Plugin = async (ctx) => {
  // Create session manager
  const sessionManager = new SessionManager();

  // Track which brainstormer sessions belong to which OpenCode sessions
  const sessionsByOpenCodeSession = new Map<string, Set<string>>();

  // Create all tools with session tracking
  const baseTools = createBrainstormerTools(sessionManager);

  // Wrap start_session to track ownership
  const wrappedStartSession = {
    ...baseTools.start_session,
    execute: async (args: { title?: string }, toolCtx: { sessionID: string }) => {
      const result = await sessionManager.startSession({ title: args.title });
      
      // Track this brainstormer session
      const openCodeSessionId = toolCtx.sessionID;
      if (!sessionsByOpenCodeSession.has(openCodeSessionId)) {
        sessionsByOpenCodeSession.set(openCodeSessionId, new Set());
      }
      sessionsByOpenCodeSession.get(openCodeSessionId)!.add(result.session_id);
      
      return `## Session Started

| Field | Value |
|-------|-------|
| Session ID | ${result.session_id} |
| URL | ${result.url} |

Browser opened. Use question tools (pick_one, confirm, etc.) to push questions.
Use get_answer to retrieve responses.`;
    },
  };

  return {
    tool: {
      ...baseTools,
      start_session: wrappedStartSession,
    },

    event: async ({ event }) => {
      // Cleanup sessions when OpenCode session is deleted
      if (event.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } } | undefined;
        const openCodeSessionId = props?.info?.id;
        
        if (openCodeSessionId) {
          const brainstormerSessions = sessionsByOpenCodeSession.get(openCodeSessionId);
          if (brainstormerSessions) {
            for (const sessionId of brainstormerSessions) {
              await sessionManager.endSession(sessionId);
            }
            sessionsByOpenCodeSession.delete(openCodeSessionId);
          }
        }
      }
    },
  };
};

export default BrainstormerPlugin;

// Re-export types for consumers
export type * from "./types";
```

**Step 2: Verify TypeScript compiles**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Verify build works**

Run: `bun run build`
Expected: Build succeeds

---

## Task 10: Integration Test - Full Flow

**Files:**
- Create: `tests/integration/full-flow.test.ts`

**Step 1: Write integration test**

```typescript
// tests/integration/full-flow.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionManager } from "../../src/session/manager";

describe("Full Flow Integration", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    await manager.cleanup();
  });

  it("should handle complete question-answer flow", async () => {
    // 1. Start session
    const { session_id, url } = await manager.startSession({ title: "Integration Test" });
    expect(session_id).toBeTruthy();
    expect(url).toContain("localhost");

    // 2. Push a question
    const { question_id } = manager.pushQuestion(session_id, "confirm", {
      question: "Do you approve?",
    });
    expect(question_id).toBeTruthy();

    // 3. Check status (should be pending)
    const pendingResult = await manager.getAnswer({ question_id, block: false });
    expect(pendingResult.completed).toBe(false);
    expect(pendingResult.status).toBe("pending");

    // 4. Simulate WebSocket response
    manager.handleWsMessage(session_id, {
      type: "response",
      id: question_id,
      answer: { choice: "yes" },
    });

    // 5. Check status (should be answered)
    const answeredResult = await manager.getAnswer({ question_id, block: false });
    expect(answeredResult.completed).toBe(true);
    expect(answeredResult.status).toBe("answered");
    expect(answeredResult.response).toEqual({ choice: "yes" });

    // 6. End session
    const endResult = await manager.endSession(session_id);
    expect(endResult.ok).toBe(true);
  });

  it("should handle multiple questions in queue", async () => {
    const { session_id } = await manager.startSession({});

    // Push multiple questions
    const q1 = manager.pushQuestion(session_id, "confirm", { question: "Q1?" });
    const q2 = manager.pushQuestion(session_id, "confirm", { question: "Q2?" });
    const q3 = manager.pushQuestion(session_id, "confirm", { question: "Q3?" });

    // List should show all 3
    const list = manager.listQuestions(session_id);
    expect(list.questions.length).toBe(3);

    // Answer in order
    manager.handleWsMessage(session_id, { type: "response", id: q1.question_id, answer: { choice: "yes" } });
    manager.handleWsMessage(session_id, { type: "response", id: q2.question_id, answer: { choice: "no" } });
    manager.handleWsMessage(session_id, { type: "response", id: q3.question_id, answer: { choice: "yes" } });

    // All should be answered
    const r1 = await manager.getAnswer({ question_id: q1.question_id, block: false });
    const r2 = await manager.getAnswer({ question_id: q2.question_id, block: false });
    const r3 = await manager.getAnswer({ question_id: q3.question_id, block: false });

    expect(r1.response).toEqual({ choice: "yes" });
    expect(r2.response).toEqual({ choice: "no" });
    expect(r3.response).toEqual({ choice: "yes" });
  });

  it("should handle blocking get_answer with timeout", async () => {
    const { session_id } = await manager.startSession({});
    const { question_id } = manager.pushQuestion(session_id, "confirm", { question: "Test?" });

    // Start blocking call with short timeout
    const startTime = Date.now();
    const result = await manager.getAnswer({ question_id, block: true, timeout: 100 });
    const elapsed = Date.now() - startTime;

    // Should timeout
    expect(result.completed).toBe(false);
    expect(result.status).toBe("timeout");
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(500); // Should not wait much longer
  });
});
```

**Step 2: Run integration tests**

Run: `bun test tests/integration/full-flow.test.ts`
Expected: All tests PASS

---

## Task 11: Final Build and Verification

**Step 1: Run all tests**

Run: `bun test`
Expected: All tests PASS

**Step 2: Run type check**

Run: `bun run typecheck`
Expected: No errors

**Step 3: Run build**

Run: `bun run build`
Expected: Build succeeds

**Step 4: Verify dist output**

Run: `ls -la dist/`
Expected: Contains `index.js` and `index.d.ts`

**Step 5: Commit all changes**

```bash
git add -A
git commit -m "feat(brainstormer): complete plugin implementation with tools and tests

- Add plugin entry point with session cleanup hook
- Add 21 tool definitions (session, question, response tools)
- Add placeholder UI bundle with basic question rendering
- Add comprehensive tests for session manager and tools
- Add integration tests for full question-answer flow"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 0 | **Review and fix existing code** | `src/session/manager.ts`, `src/session/types.ts`, `src/types.ts` |
| 1 | UI bundle placeholder (build dependency) | `src/ui/bundle.ts` |
| 2 | Plugin entry point | `src/index.ts` |
| 3 | Session management tools | `src/tools/index.ts`, `src/tools/session.ts` |
| 4 | Question tools (16 types) | `src/tools/questions.ts` |
| 5 | Response tools | `src/tools/responses.ts` |
| 6 | Full UI bundle implementation | `src/ui/bundle.ts` (expand) |
| 7 | Session manager tests | `tests/session/manager.test.ts` |
| 8 | Tool definition tests | `tests/tools/session.test.ts` |
| 9 | OpenCode session cleanup | `src/index.ts` (update) |
| 10 | Integration tests | `tests/integration/full-flow.test.ts` |
| 11 | Final verification | Build and commit |

## Future Tasks (Not in Scope)

The following are identified but not included in this plan:
- **React UI build pipeline** - Currently using inline HTML/JS. A proper React build with Vite would be a separate task.
- **Advanced question components** - `show_diff`, `show_plan`, `rank` (drag-drop), `ask_image`, `ask_file`, `ask_code` need richer UI implementations.
- **Keyboard navigation** - Accessibility improvements.
- **Mobile responsiveness** - Current UI is desktop-focused.
- **Theme support** - Light/dark mode based on system preference.
