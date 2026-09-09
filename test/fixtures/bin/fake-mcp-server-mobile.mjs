#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("9.9.9-fake\n");
  process.exit(0);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respondText(id, text, isError = false) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      ...(isError ? { isError: true } : {})
    }
  });
}

function handleToolCall(id, name, toolArgs) {
  if (name === "mobile_list_available_devices") {
    respondText(id, JSON.stringify({
      devices: process.env.TAPHOUND_FAKE_MCP_DEVICES === undefined
        ? [{ id: "emulator-5554", platform: "android", state: "online" }]
        : JSON.parse(process.env.TAPHOUND_FAKE_MCP_DEVICES)
    }));
    return;
  }
  if (name === "mobile_list_apps") {
    respondText(id, [
      "Fake App (com.example.app)",
      "Settings (com.android.settings)"
    ].join("\n"));
    return;
  }
  if (name === "mobile_save_screenshot") {
    writeFileSync(toolArgs.saveTo, "fixture image");
    respondText(id, `Screenshot saved to: ${toolArgs.saveTo}`);
    return;
  }
  respondText(id, `unsupported fake tool: ${name}`, true);
}

function handleMessage(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mobile-mcp", version: "9.9.9-fake" }
      }
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    return;
  }
  if (message.method === "tools/call") {
    handleToolCall(
      message.id,
      message.params?.name ?? "",
      message.params?.arguments ?? {}
    );
    return;
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `method not found: ${String(message.method)}`
      }
    });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() !== "") {
      try {
        handleMessage(JSON.parse(line));
      } catch {
        // Ignore malformed frames; the client aborts on protocol errors.
      }
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
