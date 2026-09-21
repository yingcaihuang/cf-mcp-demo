import {
  resolveConfig,
  type Env,
  type SignatureTimestampMode,
} from "./env.js";

/** 鉴权接口返回体 */
interface TokenResponse {
  code: number;
  message: string;
  data?: {
    token: string;
    refresh_token: string;
    /** access_token 过期时间，Unix 秒 */
    expire: number;
    uid: string;
    username: string;
  };
}

interface CachedToken {
  token: string;
  /** Unix 毫秒 */
  expiresAtMs: number;
  /** 实际成功的签名时间戳格式，后续直接复用，省掉一次试错 */
  mode: SignatureTimestampMode;
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

/** RFC1123 格式，形如 `Fri, 26 Apr 2024 01:46:32 GMT` */
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
 * 签名算法（来自文档）：`hash_hmac('sha512', request_timestamp + ak + sk, sk)`
 * 即 HMAC-SHA512，密钥为 sk，消息为三者拼接，输出十六进制小写字符串
 * （PHP hash_hmac 默认输出 hex）。
 */
export async function computeSignature(
  requestTimestamp: string,
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
    encoder.encode(`${requestTimestamp}${accessKey}${secretKey}`),
  );
  return toHex(signature);
}

/** 用指定的时间戳格式做一次鉴权请求 */
async function requestToken(
  baseUrl: string,
  accessKey: string,
  secretKey: string,
  mode: SignatureTimestampMode,
): Promise<CachedToken> {
  const now = new Date();
  const requestDate = toRfc1123(now);
  // x-request-date 始终是 RFC1123；签名里用哪种表示由 mode 决定。
  const signatureTimestamp =
    mode === "unix" ? String(Math.floor(now.getTime() / 1000)) : requestDate;

  const signature = await computeSignature(
    signatureTimestamp,
    accessKey,
    secretKey,
  );

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/API/OAuth/token`, {
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
      `无法连接鉴权接口 ${baseUrl}/API/OAuth/token（${reason}）。` +
        `请确认 RACORE_API_BASE_URL 配置的网关地址正确且可达。`,
    );
  }

  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `鉴权请求失败 (HTTP ${response.status}, 签名模式 ${mode}): ${truncate(rawBody)}`,
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
      `鉴权被拒绝 (code=${parsed.code}, 签名模式 ${mode}): ${parsed.message ?? "无错误信息"}`,
    );
  }

  const { token, expire } = parsed.data;
  // expire 是 Unix 秒。个别环境可能不返回合理值，兜底按 24 小时算。
  const expiresAtMs =
    typeof expire === "number" && expire > 0
      ? expire * 1000
      : Date.now() + 24 * 60 * 60 * 1000;

  return { token, expiresAtMs, mode };
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 获取有效 token。优先命中缓存；未命中时发起鉴权，并在签名格式不确定的情况下
 * 自动用另一种时间戳格式重试一次。
 */
export async function getAccessToken(
  env: Env,
  options: { forceRefresh?: boolean } = {},
): Promise<string> {
  const { accessKey, secretKey, baseUrl, timestampMode } = resolveConfig(env);
  const cacheKey = `${baseUrl}|${accessKey}`;

  if (!options.forceRefresh) {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > Date.now()) {
      return cached.token;
    }
  } else {
    tokenCache.delete(cacheKey);
  }

  const existing = inFlight.get(cacheKey);
  if (existing) return (await existing).token;

  const task = (async (): Promise<CachedToken> => {
    // 已知成功过的格式优先，否则用配置的格式
    const preferred = tokenCache.get(cacheKey)?.mode ?? timestampMode;
    const fallback: SignatureTimestampMode =
      preferred === "rfc1123" ? "unix" : "rfc1123";

    try {
      return await requestToken(baseUrl, accessKey, secretKey, preferred);
    } catch (firstError) {
      // 文档对 request_timestamp 的表述有歧义（请求头是 RFC1123，参数名却叫
      // timestamp），所以这里用另一种格式再试一次，避免因格式猜错而完全不可用。
      try {
        return await requestToken(baseUrl, accessKey, secretKey, fallback);
      } catch (secondError) {
        throw new Error(
          `两种签名时间戳格式均鉴权失败。` +
            `${preferred}: ${(firstError as Error).message} | ` +
            `${fallback}: ${(secondError as Error).message}`,
        );
      }
    }
  })();

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
