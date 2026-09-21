import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env.js";
import { registerStatisticsTools } from "./tools/statistics.js";

const SERVER_NAME = "racore-cdn-statistics";
const SERVER_VERSION = "0.1.0";
const MCP_ROUTE = "/mcp";

/**
 * 每个请求新建一个 McpServer。无状态 handler 要求工厂函数而不是单例，
 * 这里用闭包把 env 带进来（factory 自身的上下文参数不含 env）。
 */
function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerStatisticsTools(server, env);

  return server;
}

/** 恒定时间字符串比较，避免共享密钥被时序攻击逐字节试探 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  // 长度不同直接返回 false，但仍走完循环以减少长度以外的信息泄漏
  let mismatch = aBytes.length === bBytes.length ? 0 : 1;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i += 1) {
    mismatch |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return mismatch === 0;
}

/**
 * 可选的共享密钥校验。设置了 MCP_AUTH_TOKEN 就强制校验 Authorization 头；
 * 没设置则放行，但该端点等于把账号的 CDN 统计数据公开暴露，务必配置。
 */
function checkAuthorization(request: Request, env: Env): Response | null {
  const expected = env.MCP_AUTH_TOKEN;
  if (!expected) return null;

  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const provided = match?.[1]?.trim();

  if (!provided || !timingSafeEqual(provided, expected)) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="racore-mcp"',
        },
      },
    );
  }
  return null;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        server: SERVER_NAME,
        version: SERVER_VERSION,
        mcp_endpoint: MCP_ROUTE,
        auth_required: Boolean(env.MCP_AUTH_TOKEN),
        credentials_configured: Boolean(
          env.RACORE_ACCESS_KEY && env.RACORE_SECRET_KEY,
        ),
      });
    }

    if (url.pathname === MCP_ROUTE) {
      const unauthorized = checkAuthorization(request, env);
      if (unauthorized) return unauthorized;

      // 无 notify / subscriptions 需求，因此按官方文档允许的方式在请求内构造 handler，
      // 这是把 env 传给工具实现的最直接做法。
      const handler = createMcpHandler(() => createServer(env), {
        route: MCP_ROUTE,
        onerror: (error) => {
          console.error("[mcp] handler error:", error.message);
        },
      });

      return handler(request, env, ctx);
    }

    return new Response(
      [
        `${SERVER_NAME} v${SERVER_VERSION}`,
        "",
        `MCP endpoint: POST ${url.origin}${MCP_ROUTE}`,
        `Health check:      ${url.origin}/health`,
        "",
        "对接 Racore CDN Statistic Analysis，共 15 个统计工具。",
      ].join("\n"),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
} satisfies ExportedHandler<Env>;
