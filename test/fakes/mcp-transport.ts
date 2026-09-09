import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export interface FakeMcpTransportCall {
  method: string;
  params: unknown;
}

export interface FakeMcpToolResult {
  text: string;
  isError?: boolean | undefined;
}

export class FakeMcpTransport implements Transport {
  public readonly sent: FakeMcpTransportCall[] = [];
  public startCalls = 0;
  public closeCalls = 0;
  public nextToolResult: FakeMcpToolResult | undefined;
  public serverInfo = { name: "fake-mobile-mcp", version: "9.9.9" };
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  public start(): Promise<void> {
    this.startCalls += 1;
    return Promise.resolve();
  }

  public send(message: JSONRPCMessage): Promise<void> {
    if (!("method" in message)) {
      return Promise.resolve();
    }
    this.sent.push({ method: message.method, params: message.params });
    if (!("id" in message)) {
      return Promise.resolve();
    }
    const id = message.id;
    const response = {
      jsonrpc: "2.0" as const,
      id,
      result: this.resultFor(message.method)
    };
    queueMicrotask(() => {
      this.onmessage?.(response);
    });
    return Promise.resolve();
  }

  public close(): Promise<void> {
    this.closeCalls += 1;
    this.onclose?.();
    return Promise.resolve();
  }

  private resultFor(method: string): Record<string, unknown> {
    if (method === "initialize") {
      return {
        protocolVersion: "2025-11-25",
        capabilities: {},
        serverInfo: this.serverInfo
      };
    }
    if (method === "tools/call") {
      const configured = this.nextToolResult ?? { text: "" };
      this.nextToolResult = undefined;
      return {
        content: [{ type: "text", text: configured.text }],
        ...(configured.isError === true ? { isError: true } : {})
      };
    }
    return {};
  }
}
