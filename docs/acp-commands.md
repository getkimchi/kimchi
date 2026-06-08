# ACP Available Commands — VS Code Extension Integration Guide

This document explains how VS Code extensions can use the `available_commands_update` notification to discover and trigger ferment workflows via the Agent Connection Protocol (ACP).

## Overview

The `available_commands_update` is a session notification that the ACP server sends to advertise available commands. This allows ACP clients (such as VS Code extensions) to:

- Discover what commands the agent supports
- Display commands in a UI (command palette, buttons, menu items)
- Invoke commands when the user selects them

## When Commands Are Sent

The server sends `available_commands_update` at two points:

1. **Session initialization** — When a new session is created or loaded, the server sends the current available commands
2. **Ferment state changes** — When the ferment state changes (e.g., new ferment available, ferment completed), the server sends an updated command list

## Notification Structure

```typescript
{
    sessionId: string,           // The session this notification belongs to
    update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
            {
                name: string,           // Command identifier (e.g., "create_ferment")
                description: string,    // Human-readable description
                input?: {
                    hint: string        // Placeholder text for input field
                }
            }
        ]
    }
}
```

## The `create_ferment` Command

The primary command exposed for VS Code integration is `create_ferment`:

```typescript
{
    name: "create_ferment",
    description: "Create a new ferment workflow",
    input: {
        hint: "Describe the task or paste ferment ID"
    }
}
```

This command allows users to start a new ferment workflow from within your VS Code extension.

## How the Server Handles the Command

When a user sends a prompt containing `/create_ferment`, the ACP server:

1. **Parses the command**: Extracts the title from text following the command
2. **Transforms the request**: Converts the command into a tool invocation hint that triggers `request_ferment_workflow`
3. **Passes to agent**: The transformed prompt instructs the agent to call the ferment workflow tool

Example command handling:

```typescript
// User sends: "/create_ferment Rewrite login flow"
// Server transforms to:
// "Start a ferment workflow using request_ferment_workflow tool 
//  with title "Rewrite login flow" and intent: User initiated via ACP command: Rewrite login flow"
```

The `request_ferment_workflow` tool then:
- Validates no other ferment is active
- Prompts for user confirmation (if UI available)
- Creates the ferment draft
- Activates the ferment workflow

## How VS Code Extensions Should Handle It

### Step 1: Subscribe to Session Notifications

Listen for `session/notify` messages from the ACP server:

```typescript
// In your ACP client connection handler
connection.onNotification('session/notify', (params: SessionNotification) => {
    if (params.update.sessionUpdate === 'available_commands_update') {
        handleAvailableCommandsUpdate(params.update.availableCommands);
    }
});
```

### Step 2: Store and Display Commands

Maintain a list of available commands and update your UI:

```typescript
let availableCommands: AvailableCommand[] = [];

function handleAvailableCommandsUpdate(commands: AvailableCommand[]) {
    availableCommands = commands;
    
    // Update VS Code command palette
    availableCommands.forEach(cmd => {
        vscode.commands.registerCommand(
            `ferment.${cmd.name}`,
            async () => {
                await invokeFermentCommand(cmd.name, cmd.input?.hint);
            }
        );
    });
}
```

### Step 3: Display in Command Palette

Register commands so they appear in VS Code's command palette:

```typescript
// Register all available commands
availableCommands.forEach(cmd => {
    const commandId = `ferment.${cmd.name}`;
    
    vscode.commands.registerCommand(commandId, async () => {
        // Get user input if command requires it
        const userInput = cmd.input
            ? await vscode.window.showInputBox({
                  prompt: cmd.description,
                  placeHolder: cmd.input.hint
              })
            : undefined;
        
        // Invoke the command via ACP
        await invokeFermentCommand(cmd.name, userInput);
    });
    
    // Optionally add to command palette with a specific label
    vscode.commands.registerCommand(commandId, () => {}, {
        id: commandId,
        label: cmd.name,
        description: cmd.description
    });
});
```

### Step 4: Handle Command Invocation

When the user invokes a command, send it to the agent:

```typescript
async function invokeFermentCommand(commandName: string, userInput?: string) {
    // Build the command string (similar to slash command format)
    const commandText = userInput
        ? `/${commandName} ${userInput}`
        : `/${commandName}`;
    
    // Send as a prompt to the ACP session
    await connection.sendRequest('session/prompt', {
        sessionId: currentSessionId,
        prompt: [{ type: 'text', text: commandText }]
    });
}
```

## How to Add More Commands

To extend the available commands, update the server implementation:

### 1. Define the command in the available commands list

In `src/modes/acp/server.ts`, modify the `getAvailableCommands()` function:

```typescript
function getAvailableCommands(fermentState: FermentState): AvailableCommand[] {
    const commands: AvailableCommand[] = [
        {
            name: 'create_ferment',
            description: 'Create a new ferment workflow for structured multi-step project work',
            input: {
                hint: 'Provide a concise title (3-5 words) and full intent description'
            }
        }
    ];
    
    // Add new commands here
    if (fermentState?.status === 'running') {
        commands.push({
            name: 'pause_ferment',
            description: 'Pause the current ferment',
            // No input required
        });
        
        commands.push({
            name: 'complete_ferment',
            description: 'Mark the current ferment as complete',
            input: {
                hint: 'Add completion notes (optional)'
            }
        });
    }
    
    return commands;
}
```

### 2. Register a handler for the new command

In your ACP prompt handler, recognize the new command:

```typescript
async prompt(params: PromptRequest): Promise<PromptResponse> {
    const text = params.prompt
        .map((b: ContentBlock) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
    
    // Handle commands
    if (text.startsWith('/create_ferment')) {
        // Parse command arguments
        const commandArg = text.slice('/create_ferment'.length).trim();
        const title = commandArg || 'New Ferment';
        const intent = commandArg
            ? `User initiated via ACP command: ${commandArg}`
            : 'User initiated a new ferment workflow via ACP command';
        
        // Transform into a prompt that triggers the request_ferment_workflow tool
        text = `Start a ferment workflow using request_ferment_workflow tool with title "${title}" and intent: ${intent}`;
    } else if (text.startsWith('/pause_ferment')) {
        // Handle pause_ferment command
    } else if (text.startsWith('/complete_ferment')) {
        // Handle complete_ferment command
    }
    
    // ... rest of prompt handling
}
```

### 3. Send updated commands when state changes

Emit `available_commands_update` after any state change that affects available commands:

```typescript
// After ferment state changes
this.send({
    sessionId,
    update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: getAvailableCommands(newFermentState)
    }
});
```

## Example: Complete VS Code Extension Handler

```typescript
import * as vscode from 'vscode';
import type { SessionNotification, AvailableCommand } from '@agentclientprotocol/sdk';

interface FermentCommandsExtension {
    activate(context: vscode.ExtensionContext): void;
}

export function activate(context: vscode.ExtensionContext): void {
    let availableCommands: AvailableCommand[] = [];
    let currentSessionId: string | null = null;
    
    // Subscribe to session notifications
    acpConnection.onNotification('session/notify', (params: SessionNotification) => {
        if (params.update.sessionUpdate === 'available_commands_update') {
            availableCommands = params.update.availableCommands;
            registerFermentCommands(availableCommands);
        }
    });
    
    function registerFermentCommands(commands: AvailableCommand[]): void {
        commands.forEach(cmd => {
            const commandId = `ferment.${cmd.name}`;
            
            // Dispose existing command if present
            const existing = vscode.commands.getCommands(true)
                .then(cmds => {
                    if (cmds.includes(commandId)) {
                        vscode.commands.registerCommand(commandId, () => {});
                    }
                });
            
            const disposable = vscode.commands.registerCommand(commandId, async () => {
                const userInput = cmd.input
                    ? await vscode.window.showInputBox({
                          prompt: cmd.description,
                          placeHolder: cmd.input.hint
                      })
                    : undefined;
                
                // Send command to ACP
                await acpConnection.sendRequest('session/prompt', {
                    sessionId: currentSessionId!,
                    prompt: [{
                        type: 'text',
                        text: userInput
                            ? `/${cmd.name} ${userInput}`
                            : `/${cmd.name}`
                    }]
                });
            });
            
            context.subscriptions.push(disposable);
        });
    }
}
```

## Related Documentation

- [Ferment Overview](./ferment.md) — Complete guide to ferment workflows
- [ACP SDK Types](./ferment/acp-sdk-types.md) — Detailed type definitions
- [ACP Notification Pattern](./ferment/acp-notification-pattern.md) — How notifications work