import type { McpServer } from "@modelcontextprotocol/server";
import { callRacoreApi, RacoreApiError, type RacoreResponse } from "../client.js";
import type { Env } from "../env.js";
import {
  buildTopResourceFields,
  httpCodeDetailFields,
  httpCodeFields,
  timeSeriesFields,
  timeSeriesFieldsNoCombine,
  topDomainsFields,
} from "../schemas.js";

/**
 * 单次工具结果的字符上限。5 分钟粒度 × 30 天约 8600 个数据点，直接回传会
 * 挤占模型上下文，因此超限时按比例抽稀并在结果里说明。
 */
const MAX_RESULT_CHARS = 60_000;
/** 抽稀后每个数组保留的元素数量 */
const TRUNCATED_ARRAY_LIMIT = 300;

type Json = Record<string, unknown>;

/** 递归裁剪过长数组，保留首尾以便观察趋势两端 */
function truncateArrays(value: unknown, limit: number): unknown {
  if (Array.isArray(value)) {
    if (value.length <= limit) {
      return value.map((item) => truncateArrays(item, limit));
    }
    const head = Math.ceil(limit / 2);
    const tail = limit - head;
    return [
      ...value.slice(0, head).map((item) => truncateArrays(item, limit)),
      {
        _omitted: value.length - limit,
        _note: `已省略中间 ${value.length - limit} 条数据，请缩小时间范围以获取完整明细`,
      },
      ...value.slice(value.length - tail).map((item) => truncateArrays(item, limit)),
    ];
  }
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [key, item] of Object.entries(value as Json)) {
      out[key] = truncateArrays(item, limit);
    }
    return out;
  }
  return value;
}

/** 把接口响应序列化成工具返回文本，必要时抽稀 */
function formatResult(payload: RacoreResponse): string {
  const full = JSON.stringify(payload, null, 2);
  if (full.length <= MAX_RESULT_CHARS) return full;

  const reduced = truncateArrays(payload, TRUNCATED_ARRAY_LIMIT) as Json;
  reduced._truncated = true;
  reduced._truncation_note =
    `原始响应约 ${full.length} 字符，已超出单次返回上限，数组已抽稀。` +
    `如需完整数据请缩小 start_time/end_time 区间，或改用更粗的统计维度。`;
  return JSON.stringify(reduced, null, 2);
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /** MCP SDK 的结果类型允许附加字段，这里补上索引签名以满足其约束 */
  [extra: string]: unknown;
}

function successResult(payload: RacoreResponse): ToolResult {
  return { content: [{ type: "text", text: formatResult(payload) }] };
}

function errorResult(error: unknown): ToolResult {
  const message =
    error instanceof RacoreApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text", text: `调用失败：${message}` }], isError: true };
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  path: string;
  inputSchema: Record<string, unknown>;
  /** 结果后处理，例如解码 UA */
  transform?: (payload: RacoreResponse) => RacoreResponse;
}

function registerTool(
  server: McpServer,
  env: Env,
  definition: ToolDefinition,
): void {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: definition.inputSchema as any,
    },
    async (args: Record<string, unknown>): Promise<ToolResult> => {
      try {
        const payload = await callRacoreApi(env, definition.path, args ?? {});
        return successResult(
          definition.transform ? definition.transform(payload) : payload,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

/** Top UA 返回的 ua 字段是 URL 编码的（文档示例甚至是双重编码），解出可读值 */
function decodeUaField(payload: RacoreResponse): RacoreResponse {
  if (!Array.isArray(payload.data)) return payload;

  const decodeTwice = (raw: string): string => {
    let out = raw;
    for (let i = 0; i < 2; i += 1) {
      try {
        const next = decodeURIComponent(out);
        if (next === out) break;
        out = next;
      } catch {
        break;
      }
    }
    return out;
  };

  return {
    ...payload,
    data: payload.data.map((item) => {
      if (!item || typeof item !== "object") return item;
      const row = item as Json;
      if (typeof row.ua !== "string") return row;
      return { ...row, ua_decoded: decodeTwice(row.ua) };
    }),
  };
}

const TIME_HINT =
  "时间范围二选一：传 scope（如 today/last7days/month），或同时传 start_time 与 end_time（yyyy-mm-dd hh:mm）。仅支持近 90 天。";

/** 注册全部 15 个 Statistic Analysis 工具 */
export function registerStatisticsTools(server: McpServer, env: Env): void {
  // ---------- 时序类：带宽 / 流量 / 请求数 ----------
  registerTool(server, env, {
    name: "racore_query_bandwidth",
    title: "查询带宽",
    description: `查询 CDN 加速带宽明细（单位 bps，5 分钟粒度）。${TIME_HINT} 传 is_combine=0 可按域名分组返回。`,
    path: "/API/cdn/statistics/bandwidth",
    inputSchema: timeSeriesFields,
  });

  registerTool(server, env, {
    name: "racore_query_origin_bandwidth",
    title: "查询回源带宽",
    description: `查询回源带宽明细（单位 bps）。回源指 CDN 节点未命中缓存时回到源站的流量。${TIME_HINT} 此接口不支持 is_combine。`,
    path: "/API/cdn/statistics/src/bandwidth",
    inputSchema: timeSeriesFieldsNoCombine,
  });

  registerTool(server, env, {
    name: "racore_query_traffic",
    title: "查询流量",
    description: `查询 CDN 加速流量明细（单位字节）。${TIME_HINT} 传 is_combine=0 可按域名分组返回。`,
    path: "/API/cdn/statistics/flow",
    inputSchema: timeSeriesFields,
  });

  registerTool(server, env, {
    name: "racore_query_hit_traffic",
    title: "查询命中流量",
    description: `查询缓存命中流量明细（单位字节，5 分钟粒度）。与总流量对比可算出流量命中率。${TIME_HINT}`,
    path: "/API/cdn/statistics/hit/flow",
    inputSchema: timeSeriesFields,
  });

  registerTool(server, env, {
    name: "racore_query_origin_traffic",
    title: "查询回源流量",
    description: `查询回源流量明细（单位字节）。${TIME_HINT} 此接口不支持 is_combine。`,
    path: "/API/cdn/statistics/src/flow",
    inputSchema: timeSeriesFieldsNoCombine,
  });

  registerTool(server, env, {
    name: "racore_query_request_count",
    title: "查询请求数",
    description: `查询 CDN 总请求数明细（5 分钟粒度）。${TIME_HINT} 传 is_combine=0 可按域名分组返回。`,
    path: "/API/cdn/statistics/request",
    inputSchema: timeSeriesFields,
  });

  registerTool(server, env, {
    name: "racore_query_hit_request_count",
    title: "查询命中请求数",
    description: `查询缓存命中请求数明细（5 分钟粒度）。与总请求数对比可算出请求命中率。${TIME_HINT} 传 is_combine=0 可按域名分组返回。`,
    path: "/API/cdn/statistics/hit/request",
    inputSchema: timeSeriesFields,
  });

  registerTool(server, env, {
    name: "racore_query_origin_request_count",
    title: "查询回源请求数",
    description: `查询回源请求数明细（5 分钟粒度）。${TIME_HINT} 此接口不支持 is_combine。`,
    path: "/API/cdn/statistics/src/request",
    inputSchema: timeSeriesFieldsNoCombine,
  });

  // ---------- HTTP 状态码 ----------
  registerTool(server, env, {
    name: "racore_query_http_status_code",
    title: "查询 HTTP 状态码明细与汇总",
    description:
      `查询 HTTP 状态码请求数的时序明细与全周期汇总。不传 codes/code 时返回 2xx/3xx/4xx/5xx 四个分段；` +
      `传 codes（如 4xx）或 code（如 404）时返回对应明细。响应除 data 外还含 report 字段（含各状态码的 req 与占比 ratio）。${TIME_HINT}`,
    path: "/API/cdn/statistics/http/code",
    inputSchema: httpCodeFields,
  });

  registerTool(server, env, {
    name: "racore_query_http_status_code_by_domain",
    title: "按域名聚合 HTTP 状态码请求总量",
    description:
      `以域名为维度聚合 HTTP 状态码请求总量，支持用 state_group 过滤 2xx/3xx/4xx/5xx（留空返回全部状态码总量）。` +
      `支持 limit/page 分页，响应含 total、total_page。注意此接口的参数名是 state_group，不是 codes。${TIME_HINT}`,
    path: "/API/cdn/statistics/http/code/detail",
    inputSchema: httpCodeDetailFields,
  });

  // ---------- 国家 / 地区 ----------
  registerTool(server, env, {
    name: "racore_query_country_region_consumption",
    title: "查询国家/地区消耗明细",
    description:
      `按国家/地区维度查询消耗明细，返回每个地区的请求数 req、请求占比 req_ratio、流量 flow（字节）、流量占比 flow_ratio。` +
      `响应还含 country_codes 国家码中英文对照表，可用于把 region 码（如 CN）翻译成可读名称。${TIME_HINT}`,
    path: "/API/cdn/statistics/district",
    inputSchema: timeSeriesFieldsNoCombine,
  });

  // ---------- Top 排行 ----------
  registerTool(server, env, {
    name: "racore_top_domains",
    title: "Top 域名排行",
    description:
      `查询账号下域名的消耗排行，返回每个域名的请求数 req、请求占比 req_ratio、流量 flow（字节）、流量占比 flow_ratio。` +
      `此接口只接受时间范围参数，不支持按 domain 过滤（它本身就是跨域名排行），也无时间维度分组。${TIME_HINT}`,
    path: "/API/cdn/statistics/top/domain",
    inputSchema: topDomainsFields,
  });

  registerTool(server, env, {
    name: "racore_top_url",
    title: "Top URL 排行",
    description:
      `查询访问量最高的 URL 排行。sorted=url_size 按流量排序（默认，返回 traffic 字段），sorted=url_count 按请求数排序（返回 count 字段）。` +
      `domain 只支持单个域名。${TIME_HINT}`,
    path: "/API/cdn/domain/top/url",
    inputSchema: buildTopResourceFields(["url_size", "url_count"], "url_size"),
  });

  registerTool(server, env, {
    name: "racore_top_referer",
    title: "Top Referer 排行",
    description:
      `查询来源 Referer 排行。sorted=referer_size 按流量排序（默认，返回 traffic 字段），sorted=referer_count 按请求数排序（返回 count 字段）。` +
      `referer 为 "-" 表示无 Referer 的直接访问。domain 只支持单个域名。${TIME_HINT}`,
    path: "/API/cdn/domain/top/referer",
    inputSchema: buildTopResourceFields(
      ["referer_size", "referer_count"],
      "referer_size",
    ),
  });

  registerTool(server, env, {
    name: "racore_top_ua",
    title: "Top User-Agent 排行",
    description:
      `查询客户端 User-Agent 排行。sorted=ua_size 按流量排序（默认，返回 traffic 字段），sorted=ua_count 按请求数排序（返回 count 字段）。` +
      `上游返回的 ua 是 URL 编码的，本工具额外附带解码后的 ua_decoded 字段。domain 只支持单个域名。${TIME_HINT}`,
    path: "/API/cdn/domain/top/ua",
    inputSchema: buildTopResourceFields(["ua_size", "ua_count"], "ua_size"),
    transform: decodeUaField,
  });
}
