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

/**
 * 访问控制不在应用层实现，由 Cloudflare Access（Cloudflare One）在请求到达
 * Worker 之前完成认证。部署后务必为该 Worker 的域名配置 Access 策略，
 * 否则任何知道 URL 的人都能借账号的 AK/SK 查询 CDN 统计数据。
 *
 * 详见 README 的「访问控制」一节。
 */
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
        credentials_configured: Boolean(
          env.RACORE_ACCESS_KEY && env.RACORE_SECRET_KEY,
        ),
      });
    }

    if (url.pathname === MCP_ROUTE) {
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
        "访问控制由 Cloudflare Access 在应用之外完成。",
      ].join("\n"),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
} satisfies ExportedHandler<Env>;
