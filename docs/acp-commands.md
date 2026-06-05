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
                name: string,           // Command identifier (e.g., "start_ferment")
                description: string,    // Human-readable description
                input?: {
                    hint: string        // Placeholder text for input field
                }
            }
        ]
    }
}
```

## The `start_ferment` Command

The primary command exposed for VS Code integration is `start_ferment`:

```typescript
{
    name: "start_ferment",
    description: "Start a new ferment workflow",
    input: {
        hint: "Describe the task or paste ferment ID"
    }
}
```

This command allows users to start a new ferment workflow from within your VS Code extension.

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
            name: 'start_ferment',
            description: 'Start a new ferment workflow',
            input: {
                hint: 'Describe the task or paste ferment ID'
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
    if (text.startsWith('/start_ferment')) {
        // Handle start_ferment command
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