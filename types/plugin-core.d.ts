/**
 * Type shim for zhiliao core's ToolPlugin interface.
 *
 * At runtime/deploy, src files import from "../../agent/src/agent/tool-plugin.js"
 * which resolves inside the deployment layout. In the plugin repo (standalone),
 * that relative path doesn't exist, so tsc --noEmit fails.
 *
 * Wildcard specifier matches ANY path ending in /tool-plugin.js so typecheck passes.
 * Keep in sync with zhiliao/agent/src/agent/tool-plugin.ts.
 */
declare module "*/tool-plugin.js" {
  export interface ToolDefinition {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }

  export interface ToolPlugin {
    name: string;
    init(config: Record<string, any>): Promise<void>;
    destroy?(): Promise<void>;
    getToolDefinitions(): ToolDefinition[];
    executeTool(name: string, input: Record<string, any>): Promise<string>;
    getCheapTools?(): string[];
    summarizeInput?(name: string, input: Record<string, any>): string;
    getSystemPromptAddendum?(): string;
    getSecretPatterns?(): RegExp[];
    filterOutput?(text: string): string;
    start?(context: PluginContext): Promise<void>;
    stop?(): Promise<void>;
    getCommandHandlers?(): PluginCommandHandler;
  }

  export interface PluginContext {
    sendFeishuMessage(chatId: string, msgType: string, content: string): Promise<void>;
    callLLM?(options: {
      system: string;
      prompt: string;
      maxTokens?: number;
      model?: string;
      timeoutMs?: number;
    }): Promise<string>;
  }

  export interface CommandCallContext {
    userId: string;
    chatType: "p2p" | "group";
    chatId: string;
    logId: string;
  }

  export interface PluginCommandHandler {
    subcommands: Record<
      string,
      {
        description: string;
        handle(args: string[], context: CommandCallContext): Promise<string>;
      }
    >;
  }
}
