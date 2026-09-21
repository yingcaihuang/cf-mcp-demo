/** 签名中 request_timestamp 的格式模式 */
export type SignatureTimestampMode = "rfc1123" | "unix";

/**
 * 运行时环境。绑定的「名字」以 wrangler.jsonc 为唯一来源，这里的类型只是
 * 对运行时实际取值做放宽，原因有两个：
 *
 * 1. wrangler types 会把 vars 生成为字面量类型（例如 "rfc1123"），但这些值
 *    可以在 dashboard 或 `--var` 里被改成别的字符串，按字面量处理会导致
 *    正常的取值比较被判成不可能分支。
 * 2. 密钥虽然在 wrangler.jsonc 里声明为必需，本地开发或漏配时仍可能缺失。
 *    全部设为可选，好让 resolveConfig 给出一句明确的报错，而不是把
 *    undefined 拼进签名后收到一个难以定位的 401。
 */
export interface Env {
  /** Racore access_key（密钥，部署向导或 wrangler secret 录入） */
  RACORE_ACCESS_KEY?: string;
  /** Racore secret_key（密钥，部署向导或 wrangler secret 录入） */
  RACORE_SECRET_KEY?: string;
  /**
   * MCP 端点访问令牌（密钥）。设置后调用 /mcp 必须带
   * `Authorization: Bearer <token>`。已在 wrangler.jsonc 中声明为必需，
   * 以避免部署出一个任何人都能借你 AK/SK 查数据的公开端点。
   */
  MCP_AUTH_TOKEN?: string;
  /** API 网关地址，默认 https://api.racorecloud.com */
  RACORE_API_BASE_URL?: string;
  /** 签名时间戳格式，默认 rfc1123 */
  RACORE_SIGNATURE_TIMESTAMP_MODE?: string;
}

/**
 * 编译期防漂移检查：如果在 wrangler.jsonc 里新增了 vars 或 secrets 却忘了
 * 在上面的 Env 里补声明，这里会报类型错误，并把缺失的名字显示在错误信息中。
 * 仅用于类型校验，不产生运行时代码。
 */
type MissingBindings = Exclude<keyof Cloudflare.Env, keyof Env>;
type AssertNoDrift = [MissingBindings] extends [never]
  ? true
  : {
      错误: "wrangler.jsonc 中存在 src/env.ts 未声明的绑定，请补充 Env 接口";
      缺失的绑定: MissingBindings;
    };
const _assertNoDrift: AssertNoDrift = true;
void _assertNoDrift;

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

  // 把 throw 放在这个 if 内部，TS 才能在后续代码里把两者收窄为 string
  if (!accessKey || !secretKey) {
    const missing: string[] = [];
    if (!accessKey) missing.push("RACORE_ACCESS_KEY");
    if (!secretKey) missing.push("RACORE_SECRET_KEY");
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
