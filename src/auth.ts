import { resolveConfig, type Env } from "./env.js";

/** 鉴权接口返回体 */
interface TokenResponse {
  code: number;
  message: string;
  data?: {
    token: string;
    refresh_token: string;
    /** access_token 过期时间，Unix 秒 */
    expire: number;
    uid: number | string;
    username: string;
  };
}

interface CachedToken {
  token: string;
  /** Unix 毫秒 */
  expiresAtMs: number;
}

/**
 * token 缓存。作用域是当前 isolate：无状态 MCP handler 每个请求都会新建
 * server 实例，但模块级变量在 isolate 存活期内是共享的。token 有效期 24h，
 * 因此最坏情况只是每个新 isolate 多做一次鉴权请求，完全可接受。
 */
const tokenCache = new Map<string, CachedToken>();
/** 同一 key 的并发鉴权请求去重，避免冷启动瞬间打出多个 token 请求 */
const inFlight = new Map<string, Promise<CachedToken>>();

/** 提前 5 分钟过期，留出时钟偏移和请求耗时的余量 */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** 鉴权请求超时。上游无响应时必须主动放弃，否则工具调用会一直挂住。 */
const AUTH_TIMEOUT_MS = 15_000;

/**
 * RFC1123 格式，形如 `Fri, 26 Apr 2024 01:46:32 GMT`。
 * 等价于官方 Python 示例的
 * `datetime.utcnow().strftime('%a, %d %b %Y %H:%M:%S GMT')`。
 */
export function toRfc1123(date: Date): string {
  // toUTCString() 在 workerd / V8 上产出的正是 RFC1123 格式
  return date.toUTCString();
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * 签名算法：`hmac_sha512(key=sk, msg=x_request_date + ak + sk)`，输出小写 hex。
 *
 * 注意消息里的时间戳就是 `x-request-date` 请求头那个 RFC1123 字符串本身，
 * 不是 Unix 时间戳 —— 已由官方 Python 示例与真实接口实测双重确认
 * （用 Unix 秒级时间戳会得到 401 Invalid parameter signature）。
 */
export async function computeSignature(
  requestDate: string,
  accessKey: string,
  secretKey: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(`${requestDate}${accessKey}${secretKey}`),
  );
  return toHex(signature);
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 发起一次鉴权请求 */
async function requestToken(
  baseUrl: string,
  accessKey: string,
  secretKey: string,
): Promise<CachedToken> {
  // x-request-date 与签名里的时间戳必须是同一个字符串，接口要求二者一致，
  // 且与服务端时间相差不能超过 5 分钟。
  const requestDate = toRfc1123(new Date());
  const signature = await computeSignature(requestDate, accessKey, secretKey);
  const endpoint = `${baseUrl}/API/OAuth/token`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-date": requestDate,
      },
      body: JSON.stringify({ access_key: accessKey, signature }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `无法连接鉴权接口 ${endpoint}（${reason}）。` +
        `请确认 RACORE_API_BASE_URL 指向 https://portal.racorecloud.com —— ` +
        `api.racorecloud.com 的 HTTP 层不响应，会表现为连接超时。`,
    );
  }

  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `鉴权请求被拒绝 (HTTP ${response.status}) ${endpoint}: ${truncate(rawBody)}`,
    );
  }

  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(rawBody) as TokenResponse;
  } catch {
    throw new Error(
      `鉴权接口返回了非 JSON 内容 (HTTP ${response.status}): ${truncate(rawBody)}`,
    );
  }

  if (parsed.code !== 1 || !parsed.data?.token) {
    throw new Error(
      `鉴权失败 (code=${parsed.code}): ${parsed.message ?? "无错误信息"}。` +
        `请检查 RACORE_ACCESS_KEY / RACORE_SECRET_KEY 是否正确。`,
    );
  }

  const { token, expire } = parsed.data;
  // expire 是 Unix 秒。个别环境可能不返回合理值，兜底按 24 小时算。
  const expiresAtMs =
    typeof expire === "number" && expire > 0
      ? expire * 1000
      : Date.now() + 24 * 60 * 60 * 1000;

  return { token, expiresAtMs };
}

/** 获取有效 token，优先命中 isolate 内缓存 */
export async function getAccessToken(
  env: Env,
  options: { forceRefresh?: boolean } = {},
): Promise<string> {
  const { accessKey, secretKey, baseUrl } = resolveConfig(env);
  const cacheKey = `${baseUrl}|${accessKey}`;

  if (options.forceRefresh) {
    tokenCache.delete(cacheKey);
  } else {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > Date.now()) {
      return cached.token;
    }
  }

  const existing = inFlight.get(cacheKey);
  if (existing) return (await existing).token;

  const task = requestToken(baseUrl, accessKey, secretKey);
  inFlight.set(cacheKey, task);
  try {
    const result = await task;
    tokenCache.set(cacheKey, result);
    return result.token;
  } finally {
    inFlight.delete(cacheKey);
  }
}

/** 主动作废缓存的 token，收到 401 时调用 */
export function invalidateToken(env: Env): void {
  try {
    const { accessKey, baseUrl } = resolveConfig(env);
    tokenCache.delete(`${baseUrl}|${accessKey}`);
  } catch {
    // 配置本身有问题时无需处理，调用方会看到更明确的报错
  }
}
