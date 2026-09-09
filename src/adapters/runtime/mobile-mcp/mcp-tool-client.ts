import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { MobileMcpToolError, mobileMcpConnectError } from "./mobile-mcp-errors.js";
import type {
  MobileMcpToolCallOptions,
  MobileMcpSwipeDirection,
  MobileMcpTools
} from "./mobile-mcp-tools.js";

export const MCP_TOOL_CLIENT_VERSION = "mcp-tool-client-v1";
export const DEFAULT_MOBILE_MCP_COMMAND = "mcp-server-mobile";
export const DEFAULT_MOBILE_MCP_TOOL_TIMEOUT_MS = 60_000;

export interface McpToolClientOptions {
  command?: string | undefined;
  args?: readonly string[] | undefined;
  env?: Readonly<Record<string, string>> | undefined;
  clientName?: string | undefined;
  clientVersion?: string | undefined;
  defaultTimeoutMs?: number | undefined;
  transportFactory?: (() => Transport) | undefined;
}

function defaultToolEnv(): Record<string, string> {
  const env: Record<string, string> = {
    MOBILEMCP_DISABLE_TELEMETRY: "1"
  };
  if (process.env.ANDROID_HOME !== undefined) {
    env.ANDROID_HOME = process.env.ANDROID_HOME;
  }
  return env;
}

interface CallToolOutcome {
  content: readonly {
    type: string;
    text?: unknown;
  }[];
  isError?: boolean | undefined;
}

function outcomeText(outcome: CallToolOutcome): string {
  const parts: string[] = [];
  for (const block of outcome.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

export class McpToolClient implements MobileMcpTools {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private closed = false;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly env: Record<string, string>;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly defaultTimeoutMs: number;
  private readonly transportFactory: () => Transport;

  public constructor(options: McpToolClientOptions = {}) {
    this.command = options.command ?? DEFAULT_MOBILE_MCP_COMMAND;
    this.args = options.args ?? [];
    this.env = { ...defaultToolEnv(), ...(options.env ?? {}) };
    this.clientName = options.clientName ?? "taphound";
    this.clientVersion = options.clientVersion ?? MCP_TOOL_CLIENT_VERSION;
    this.defaultTimeoutMs = options.defaultTimeoutMs
      ?? DEFAULT_MOBILE_MCP_TOOL_TIMEOUT_MS;
    this.transportFactory = options.transportFactory
      ?? ((): Transport => new StdioClientTransport({
        command: this.command,
        args: [...this.args],
        env: this.env,
        stderr: "ignore"
      }));
  }

  private ensureConnected(): Promise<Client> {
    if (this.client !== undefined) {
      return Promise.resolve(this.client);
    }
    if (this.connecting === undefined) {
      const connecting = this.connect().then((client): Client => {
        this.client = client;
        return client;
      });
      connecting.catch((): void => {
        if (this.connecting === connecting) {
          this.connecting = undefined;
        }
      });
      this.connecting = connecting;
    }
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    if (this.closed) {
      throw new Error("MCP tool client is closed");
    }
    const client = new Client(
      { name: this.clientName, version: this.clientVersion },
      { capabilities: {} }
    );
    const transport = this.transportFactory();
    try {
      await client.connect(transport);
    } catch (error) {
      throw mobileMcpConnectError(this.command, error);
    }
    return client;
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    const client = await this.ensureConnected();
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      {
        timeout: options?.timeoutMs ?? this.defaultTimeoutMs,
        ...(options?.signal === undefined ? {} : { signal: options.signal })
      }
    ) as CallToolOutcome;
    const text = outcomeText(result);
    if (result.isError === true) {
      throw new MobileMcpToolError(
        name,
        text || `${name} failed without a message`
      );
    }
    return text;
  }

  public listDevices(
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool("mobile_list_available_devices", {}, options);
  }

  public getScreenSize(
    device: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool("mobile_get_screen_size", { device }, options);
  }

  public listElements(
    device: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool("mobile_list_elements_on_screen", { device }, options);
  }

  public listApps(
    device: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool("mobile_list_apps", { device }, options);
  }

  public launchApp(
    device: string,
    packageName: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool(
      "mobile_launch_app",
      { device, packageName },
      options
    );
  }

  public terminateApp(
    device: string,
    packageName: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool(
      "mobile_terminate_app",
      { device, packageName },
      options
    );
  }

  public tap(
    device: string,
    x: number,
    y: number,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool(
      "mobile_click_on_screen_at_coordinates",
      { device, x, y },
      options
    );
  }

  public longPress(
    device: string,
    x: number,
    y: number,
    durationMs: number,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool(
      "mobile_long_press_on_screen_at_coordinates",
      { device, x, y, duration: durationMs },
      options
    );
  }

  public swipe(
    device: string,
    direction: MobileMcpSwipeDirection,
    x?: number,
    y?: number,
    distance?: number,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool(
      "mobile_swipe_on_screen",
      {
        device,
        direction,
        ...(x === undefined ? {} : { x }),
        ...(y === undefined ? {} : { y }),
        ...(distance === undefined ? {} : { distance })
      },
      options
    );
  }

  public pressButton(
    device: string,
    button: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool("mobile_press_button", { device, button }, options);
  }

  public typeKeys(
    device: string,
    text: string,
    submit: boolean,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool(
      "mobile_type_keys",
      { device, text, submit },
      options
    );
  }

  public saveScreenshot(
    device: string,
    saveTo: string,
    options?: MobileMcpToolCallOptions
  ): Promise<string> {
    return this.callTool(
      "mobile_save_screenshot",
      { device, saveTo },
      options
    );
  }

  public serverVersion(): string | undefined {
    return this.client?.getServerVersion()?.version;
  }

  public async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (client !== undefined) {
      await client.close();
    }
  }
}
