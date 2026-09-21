/** 签名中 request_timestamp 的格式模式 */
export type SignatureTimestampMode = "rfc1123" | "unix";

export interface Env {
  /** Racore access_key —— 通过 `wrangler secret put RACORE_ACCESS_KEY` 注入 */
  RACORE_ACCESS_KEY: string;
  /** Racore secret_key —— 通过 `wrangler secret put RACORE_SECRET_KEY` 注入 */
  RACORE_SECRET_KEY: string;
  /** API 网关地址，默认 https://api.racorecloud.com */
  RACORE_API_BASE_URL?: string;
  /** 签名时间戳格式，默认 rfc1123 */
  RACORE_SIGNATURE_TIMESTAMP_MODE?: SignatureTimestampMode;
  /**
   * 可选的 MCP 端点访问令牌。一旦设置，调用 /mcp 必须带
   * `Authorization: Bearer <token>`。强烈建议配置：否则任何拿到 Worker URL
   * 的人都能借你的 AK/SK 查询 CDN 统计数据。
   */
  MCP_AUTH_TOKEN?: string;
}

export const DEFAULT_API_BASE_URL = "https://api.racorecloud.com";

/**
 * 读取并校验运行时配置。缺少密钥时立即抛错，避免把 undefined 拼进签名后
 * 收到一个难以定位的 401。
 */
export function resolveConfig(env: Env): {
  accessKey: string;
  secretKey: string;
  baseUrl: string;
  timestampMode: SignatureTimestampMode;
} {
  const accessKey = env.RACORE_ACCESS_KEY;
  const secretKey = env.RACORE_SECRET_KEY;

  const missing: string[] = [];
  if (!accessKey) missing.push("RACORE_ACCESS_KEY");
  if (!secretKey) missing.push("RACORE_SECRET_KEY");
  if (missing.length > 0) {
    throw new Error(
      `缺少必需的密钥配置: ${missing.join(", ")}。` +
        `本地开发请写入 .dev.vars，线上请执行 npx wrangler secret put <NAME>。`,
    );
  }

  const mode = env.RACORE_SIGNATURE_TIMESTAMP_MODE;
  const timestampMode: SignatureTimestampMode =
    mode === "unix" || mode === "rfc1123" ? mode : "rfc1123";

  return {
    accessKey,
    secretKey,
    // 去掉末尾斜杠，避免拼接出 //API/...
    baseUrl: (env.RACORE_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    timestampMode,
  };
}
