"use strict";

/**
 * Minimal MCP client for the local dsh-as-mcp endpoint.
 *
 * The service is a plain Node process, so it can talk to 127.0.0.1 directly —
 * no CORS, no host http channel, no 5-minute tickets. Protocol: JSON-RPC over
 * Streamable HTTP; responses may be a JSON body or an SSE stream, so both are
 * parsed. The server is stateless today (no Mcp-Session-Id required).
 */

const DEFAULT_URL = "http://127.0.0.1:8790/mcp";
const DEFAULT_TIMEOUT = 20000;

class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

class DshMcpClient {
  constructor({ url, token, timeoutMs } = {}) {
    this.url = url || DEFAULT_URL;
    this.token = token || "";
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT;
    this.nextId = 1;
    this.initialized = null;
  }

  async request(method, params, timeoutMs) {
    const body = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params: params || {},
    };

    let response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || this.timeoutMs),
      });
    } catch (error) {
      const code = error?.cause?.code || error?.code || "NETWORK";
      throw new McpError(
        code === "ECONNREFUSED"
          ? "DSH 的 MCP 服务没有监听（启动 DeepSeek Harness 后会监听 8790）"
          : `连接 DSH MCP 失败：${error.message}`,
        code,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new McpError("DSH MCP 拒绝了这个 token（~/.dsh/dsh-as-mcp/token 可能已轮换）", "UNAUTHORIZED");
    }
    if (!response.ok) {
      throw new McpError(`DSH MCP 返回 HTTP ${response.status}`, `HTTP_${response.status}`);
    }

    const text = await response.text();
    const payload = parseBody(text, response.headers.get("content-type") || "");
    if (payload?.error) {
      throw new McpError(payload.error.message || "MCP 调用失败", payload.error.code);
    }
    if (!payload || payload.result === undefined) {
      throw new McpError("MCP 返回里没有 result", "BAD_RESPONSE");
    }
    return payload.result;
  }

  async ensureInitialized() {
    if (!this.initialized) {
      this.initialized = this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "dsh-session-bridge", version: "0.1.0" },
      }).catch((error) => {
        this.initialized = null;
        throw error;
      });
    }
    return this.initialized;
  }

  async listTools() {
    await this.ensureInitialized();
    const result = await this.request("tools/list", {});
    return (result.tools || []).map((tool) => tool.name);
  }

  async callTool(name, args, options = {}) {
    await this.ensureInitialized();
    const timeout = Number(options.timeoutMs) || this.timeoutMs;
    const result = await this.request("tools/call", { name, arguments: args || {} }, timeout);
    const content = Array.isArray(result.content) ? result.content : [];
    const firstText = content.find((item) => item && item.type === "text");
    const text = firstText?.text ?? "";

    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (result.isError) {
      throw new McpError(parsed?.error || text || `${name} 调用失败`, "TOOL_ERROR");
    }
    // Prefer the parsed JSON; keep the raw text for tools that return prose.
    return parsed ?? { text };
  }
}

function parseBody(text, contentType) {
  if (!text) return null;
  if (contentType.includes("text/event-stream")) {
    // Concatenate every `data:` line; the last complete JSON object wins.
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        last = JSON.parse(data);
      } catch {
        // keep the previous complete message
      }
    }
    return last;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { DshMcpClient, McpError, DEFAULT_URL };
