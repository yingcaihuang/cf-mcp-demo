import { getAccessToken, invalidateToken } from "./auth.js";
import { resolveConfig, type Env } from "./env.js";

/** Racore 接口的统一响应包装。不同接口会在同级追加 report / country_codes / 分页等字段。 */
export interface RacoreResponse {
  code: number;
  message: string;
  data?: unknown;
  [extra: string]: unknown;
}

/** 业务错误：HTTP 通了但 code != 1 */
export class RacoreApiError extends Error {
  constructor(
    readonly code: number,
    readonly apiMessage: string,
    readonly path: string,
  ) {
    super(`Racore API ${path} 返回失败 (code=${code}): ${apiMessage}`);
    this.name = "RacoreApiError";
  }
}

/** 去掉值为 undefined / null / 空字符串的字段，避免把空参数传给上游 */
function compactBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * 校验时间参数：文档明确 start_time/end_time 与 scope 互斥，且只支持近 90 天。
 * 在本地先挡掉，比等上游报一个含义模糊的错误更好定位。
 */
export function validateTimeParams(body: Record<string, unknown>): void {
  const hasRange = Boolean(body.start_time) || Boolean(body.end_time);
  const hasScope = Boolean(body.scope);

  if (hasRange && hasScope) {
    throw new Error(
      "参数冲突：start_time/end_time 不能与 scope 同时使用，请只选一种时间范围表示方式。",
    );
  }
  if (!hasRange && !hasScope) {
    throw new Error(
      "缺少时间范围：请提供 scope（如 today/last7days/month），或同时提供 start_time 与 end_time。",
    );
  }
  if (hasRange && !(body.start_time && body.end_time)) {
    throw new Error(
      "使用自定义时间范围时，start_time 与 end_time 必须同时提供。",
    );
  }

  if (body.start_time && body.end_time) {
    const start = parseApiTime(String(body.start_time));
    const end = parseApiTime(String(body.end_time));
    if (start && end) {
      if (start > end) {
        throw new Error("start_time 不能晚于 end_time。");
      }
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      if (end.getTime() - start.getTime() > ninetyDaysMs) {
        throw new Error("查询区间超过 90 天，接口仅支持近 90 天内的数据。");
      }
    }
  }
}

/** 解析 `yyyy-mm-dd hh:mm` 格式，按 UTC 处理以避免 Worker 时区歧义 */
function parseApiTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s ?? "0"),
    ),
  );
}

/** 统计接口超时。统计类查询可能较慢，给得比鉴权宽一些。 */
const API_TIMEOUT_MS = 30_000;

async function doFetch(
  baseUrl: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `无法连接 ${baseUrl}${path}（${reason}）。` +
        `请确认 RACORE_API_BASE_URL 配置的网关地址正确且可达。`,
    );
  }
}

/**
 * 调用一个 Racore 统计接口。自动完成鉴权、token 缓存复用，以及 401 时
 * 作废缓存并重试一次（覆盖 token 在 isolate 缓存期内被服务端提前失效的情况）。
 */
export async function callRacoreApi(
  env: Env,
  path: string,
  rawBody: Record<string, unknown>,
  options: { validateTime?: boolean } = {},
): Promise<RacoreResponse> {
  const { baseUrl } = resolveConfig(env);
  const body = compactBody(rawBody);

  if (options.validateTime !== false) {
    validateTimeParams(body);
  }

  let token = await getAccessToken(env);
  let response = await doFetch(baseUrl, path, token, body);

  if (response.status === 401 || response.status === 403) {
    invalidateToken(env);
    token = await getAccessToken(env, { forceRefresh: true });
    response = await doFetch(baseUrl, path, token, body);
  }

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Racore API ${path} 请求失败 (HTTP ${response.status}): ${rawText.slice(0, 500)}`,
    );
  }

  let parsed: RacoreResponse;
  try {
    parsed = JSON.parse(rawText) as RacoreResponse;
  } catch {
    throw new Error(
      `Racore API ${path} 返回了非 JSON 内容: ${rawText.slice(0, 500)}`,
    );
  }

  if (parsed.code !== 1) {
    throw new RacoreApiError(parsed.code, parsed.message ?? "无错误信息", path);
  }

  return parsed;
}
