import { XMLParser } from "fast-xml-parser";

interface Env {
  LZHE_API_KEY: string;
  LZHE_BASE_URL: string;
  BILI_SESSDATA: string;
  RSSHUB_BASE_URL?: string;
}

interface FeedSource {
  id: string;
  name: string;
  platform: string;
  feed_url: string;
  avatar_url: string | null;
}

interface ParsedItem {
  title: string;
  url: string;
  summary: string | null;
  published_at: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name: string) => ["item", "entry", "link"].includes(name),
});

function getRsshubBaseUrl(env: Env): string {
  return (
    env.RSSHUB_BASE_URL ??
    "https://rsshub.ktachibana.party"
  ).replace(/\/+$/, "");
}

function toText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const text = (value as Record<string, unknown>)["#text"];
    if (typeof text === "string") return text;
    if (typeof text === "number") return String(text);
  }
  return "";
}

function cleanSummary(raw: string): string | null {
  const text = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return text || null;
}

function parseFeed(xml: string): ParsedItem[] {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }

  const root = doc as Record<string, any>;
  const items: any[] = root?.rss?.channel?.item ?? root?.feed?.entry ?? [];
  const out: ParsedItem[] = [];

  for (const it of items) {
    let url = "";
    if (typeof it.link === "string") {
      url = it.link;
    } else if (Array.isArray(it.link)) {
      const alt =
        it.link.find(
          (l: any) =>
            typeof l === "object" &&
            (l["@_rel"] === "alternate" || l["@_rel"] === undefined)
        ) ?? it.link[0];
      if (typeof alt === "string") url = alt;
      else if (alt && typeof alt === "object") {
        url = toText(alt["@_href"]) || toText(alt["#text"]);
      }
    }

    const title = toText(it.title).trim();
    if (!title || !url) continue;

    out.push({
      title,
      url: url.trim(),
      summary: cleanSummary(toText(it.description ?? it.summary)),
      published_at: toText(it.pubDate ?? it.published).trim() || null,
    });
  }

  return out;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterMs(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.min(seconds * 1000, 15000));
  }

  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    return Math.max(0, Math.min(at - Date.now(), 15000));
  }

  return null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchWithRetry(
  url: string,
  attempts = 2,
  timeoutMs = 60000
): Promise<Response> {
  let lastError: unknown = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          Accept:
            "application/rss+xml, application/xml, text/xml, */*",
        },
      });

      if (!isRetryableStatus(res.status) || i === attempts - 1) {
        return res;
      }

      const retryAfter = getRetryAfterMs(res);
      await sleep(retryAfter ?? 1000 * (i + 1));
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) {
        await sleep(1000 * (i + 1));
      }
    }
  }

  throw lastError ?? new Error("fetch failed");
}

function isBilibiliRateLimited(code?: number, status?: number): boolean {
  return code === -412 || code === -352 || status === 412 || status === 429;
}

class BilibiliRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BilibiliRateLimitError";
  }
}

// ---------- B站直抓 ----------


const WBI_MIXIN_KEY_ENC_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const BILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const BILI_REQUEST_HEADERS = {
  "User-Agent": BILI_UA,
  "Accept-Language": "zh-CN,zh;q=0.9",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.bilibili.com/",
};

const BILI_WBI_CACHE_KEY =
  "https://feed-worker.internal/__cache/bilibili-wbi-keys";
const BILI_WBI_CACHE_TTL_SECONDS = 15 * 60;

interface BilibiliWbiKeys {
  imgKey: string;
  subKey: string;
}

let memoryWbiKeys: {
  value: BilibiliWbiKeys;
  expiresAt: number;
} | null = null;

let bilibiliRequestChain: Promise<void> = Promise.resolve();

function getMixinKey(orig: string): string {
  return WBI_MIXIN_KEY_ENC_TABLE.slice(0, 32)
    .map((i) => orig[i])
    .join("")
    .slice(0, 32);
}

async function md5hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("MD5", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function withBilibiliSpacing<T>(
  fn: () => Promise<T>,
  minIntervalMs = 1200
): Promise<T> {
  const previous = bilibiliRequestChain;

  let release!: () => void;
  bilibiliRequestChain = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    await sleep(minIntervalMs);
    return await fn();
  } finally {
    release();
  }
}

async function getBilibiliCookie(): Promise<string> {
  const res = await fetch("https://www.bilibili.com/", {
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent": BILI_UA,
      "Accept-Language": "zh-CN,zh;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) return "";

  const headersAny = res.headers as unknown as {
    getSetCookie?: () => string[];
  };

  const rawCookies: string[] =
    typeof headersAny.getSetCookie === "function"
      ? headersAny.getSetCookie()
      : String(res.headers.get("set-cookie") ?? "").split(/,(?=[^;,]+?=)/);

  return rawCookies
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function parseJsonText(text: string, label: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `B站返回非 JSON（${label} 前 80 字符: ${text.slice(0, 80)}）`
    );
  }
}

async function readBilibiliJson(
  url: string,
  headers: HeadersInit,
  label: string
): Promise<{ response: Response; data: any }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers,
  });

  const text = await response.text();
  const data = parseJsonText(text, label);

  if (isBilibiliRateLimited(data?.code, response.status)) {
    throw new BilibiliRateLimitError(
      `${label} 触发 B站风控 HTTP=${response.status} code=${data?.code} msg=${data?.message ?? "未知"}`
    );
  }

  return { response, data };
}

async function parseCachedWbiKeys(response: Response): Promise<BilibiliWbiKeys | null> {
  try {
    const value = (await response.json()) as Partial<BilibiliWbiKeys>;
    if (
      typeof value.imgKey === "string" &&
      value.imgKey &&
      typeof value.subKey === "string" &&
      value.subKey
    ) {
      return {
        imgKey: value.imgKey,
        subKey: value.subKey,
      };
    }
  } catch {
    // 缓存内容损坏时回源刷新
  }

  return null;
}

async function getBilibiliWbiKeys(): Promise<BilibiliWbiKeys> {
  if (memoryWbiKeys && memoryWbiKeys.expiresAt > Date.now()) {
    return memoryWbiKeys.value;
  }

  const cache = caches.default;
  const cacheKey = new Request(BILI_WBI_CACHE_KEY, { method: "GET" });
  const cached = await cache.match(cacheKey);

  if (cached) {
    const cachedKeys = await parseCachedWbiKeys(cached);
    if (cachedKeys) {
      memoryWbiKeys = {
        value: cachedKeys,
        expiresAt: Date.now() + BILI_WBI_CACHE_TTL_SECONDS * 1000,
      };
      return cachedKeys;
    }
  }

  const { data: nav } = await withBilibiliSpacing(() =>
    readBilibiliJson(
      "https://api.bilibili.com/x/web-interface/nav",
      BILI_REQUEST_HEADERS,
      "nav"
    )
  );

  const imgUrl = String(nav?.data?.wbi_img?.img_url ?? "");
  const subUrl = String(nav?.data?.wbi_img?.sub_url ?? "");

  if (!imgUrl || !subUrl) {
    throw new Error(
      `B站 nav 未返回 WBI key img=${imgUrl ? "ok" : "missing"} sub=${subUrl ? "ok" : "missing"}`
    );
  }

  const imgKey = imgUrl.split("/").pop()?.split(".")[0] ?? "";
  const subKey = subUrl.split("/").pop()?.split(".")[0] ?? "";

  if (!imgKey || !subKey) {
    throw new Error("B站 WBI key 格式异常");
  }

  const value: BilibiliWbiKeys = { imgKey, subKey };

  memoryWbiKeys = {
    value,
    expiresAt: Date.now() + BILI_WBI_CACHE_TTL_SECONDS * 1000,
  };

  await cache.put(
    cacheKey,
    new Response(JSON.stringify(value), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${BILI_WBI_CACHE_TTL_SECONDS}`,
      },
    })
  );

  return value;
}

function buildWbiQuery(
  params: Record<string, string>,
  mixinKey: string
): Promise<string> {
  const filteredParams = Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      value.replace(/[!'()*]/g, ""),
    ])
  );

  const query = Object.keys(filteredParams)
    .sort()
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(filteredParams[key])}`
    )
    .join("&");

  return Promise.resolve(md5hex(query + mixinKey)).then(
    (wRid) => `${query}&w_rid=${wRid}`
  );
}

async function fetchBilibiliSeriesItems(mid: string): Promise<ParsedItem[]> {
  const url = new URL(
    "https://api.bilibili.com/x/series/recArchivesByKeywords"
  );
  url.searchParams.set("mid", mid);
  url.searchParams.set("keywords", "");
  url.searchParams.set("ps", "30");
  url.searchParams.set("pn", "1");
  url.searchParams.set("orderby", "pubdate");

  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data } = await withBilibiliSpacing(() =>
        readBilibiliJson(url.toString(), BILI_REQUEST_HEADERS, "投稿列表")
      );

      if (data?.code !== 0) {
        throw new Error(
          `B站投稿列表 API 错误 code=${data?.code} msg=${data?.message ?? "未知错误"}`
        );
      }

      const archives: any[] = Array.isArray(data?.data?.archives)
        ? data.data.archives
        : [];

      const seen = new Set<string>();
      return archives
        .map((v) => {
          const bvid = String(v?.bvid ?? "").trim();
          const title = String(v?.title ?? "").trim();

          return {
            title,
            url: bvid ? `https://www.bilibili.com/video/${bvid}` : "",
            summary: cleanSummary(
              String(v?.desc ?? v?.description ?? "")
            ),
            published_at:
              Number.isFinite(Number(v?.pubdate)) && Number(v.pubdate) > 0
                ? new Date(Number(v.pubdate) * 1000).toISOString()
                : null,
          };
        })
        .filter((item) => {
          const bvid = item.url.split("/").pop() ?? "";
          if (!item.title || !bvid || seen.has(bvid)) return false;
          seen.add(bvid);
          return true;
        });
    } catch (e) {
      lastError = e;

      if (!(e instanceof BilibiliRateLimitError) || attempt === 1) {
        throw e;
      }

      await sleep(10000);
    }
  }

  throw lastError ?? new Error("B站投稿列表抓取失败");
}

async function fetchBilibiliWbiItems(
  mid: string,
  sessdata: string
): Promise<ParsedItem[]> {
  const buvid = await getBilibiliCookie();
  const cookie = buvid
    ? `${buvid}; SESSDATA=${sessdata}`
    : `SESSDATA=${sessdata}`;

  const apiHeaders = {
    ...BILI_REQUEST_HEADERS,
    Cookie: cookie,
  };

  const { imgKey, subKey } = await getBilibiliWbiKeys();
  const mixinKey = getMixinKey(imgKey + subKey);

  if (!mixinKey) {
    throw new Error("B站 WBI mixin key 生成失败");
  }

  const params: Record<string, string> = {
    mid,
    ps: "30",
    pn: "1",
    order: "pubdate",
    platform: "web",
    web_location: "1550101",
    order_avoided: "true",
    wts: Math.floor(Date.now() / 1000).toString(),
  };

  const signedQuery = await buildWbiQuery(params, mixinKey);
  const apiUrl = `https://api.bilibili.com/x/space/wbi/arc/search?${signedQuery}`;

  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data } = await withBilibiliSpacing(() =>
        readBilibiliJson(apiUrl, apiHeaders, "WBI 投稿列表")
      );

      if (data?.code !== 0) {
        throw new Error(
          `B站 WBI API 错误 code=${data?.code} msg=${data?.message ?? "未知错误"}`
        );
      }

      const vlist: any[] = Array.isArray(data?.data?.list?.vlist)
        ? data.data.list.vlist
        : [];

      return vlist
        .map((v) => ({
          title: String(v?.title ?? "").trim(),
          url: v?.bvid
            ? `https://www.bilibili.com/video/${v.bvid}`
            : "",
          summary: cleanSummary(String(v?.description ?? "")),
          published_at:
            Number.isFinite(Number(v?.created)) && Number(v.created) > 0
              ? new Date(Number(v.created) * 1000).toISOString()
              : null,
        }))
        .filter((i) => i.title && i.url);
    } catch (e) {
      lastError = e;

      if (!(e instanceof BilibiliRateLimitError) || attempt === 1) {
        throw e;
      }

      await sleep(10000);
    }
  }

  throw lastError ?? new Error("B站 WBI 投稿列表抓取失败");
}

async function fetchBilibiliItems(
  mid: string,
  sessdata: string
): Promise<ParsedItem[]> {
  let seriesError = "";

  try {
    return await fetchBilibiliSeriesItems(mid);
  } catch (e) {
    seriesError = e instanceof Error ? e.message : String(e);

    // 已触发风控时优先避免继续打 nav。
    if (e instanceof BilibiliRateLimitError) {
      return await fetchBilibiliItemsFromCachedWbi(mid, sessdata, seriesError);
    }
  }

  try {
    return await fetchBilibiliWbiItems(mid, sessdata);
  } catch (e) {
    const wbiError = e instanceof Error ? e.message : String(e);
    throw new Error(
      `B站抓取失败；投稿列表=${seriesError || "失败"}；WBI=${wbiError}`
    );
  }
}

async function fetchBilibiliItemsFromCachedWbi(
  mid: string,
  sessdata: string,
  seriesError: string
): Promise<ParsedItem[]> {
  const cache = caches.default;
  const cacheKey = new Request(BILI_WBI_CACHE_KEY, { method: "GET" });
  const cached = await cache.match(cacheKey);

  if (!cached) {
    throw new Error(
      `B站投稿列表触发风控（${seriesError}），当前无可用 WBI 缓存`
    );
  }

  const keys = await parseCachedWbiKeys(cached);
  if (!keys) {
    throw new Error(
      `B站投稿列表触发风控（${seriesError}），WBI 缓存内容无效`
    );
  }

  memoryWbiKeys = {
    value: keys,
    expiresAt: Date.now() + BILI_WBI_CACHE_TTL_SECONDS * 1000,
  };

  try {
    return await fetchBilibiliWbiItems(mid, sessdata);
  } catch (e) {
    const wbiError = e instanceof Error ? e.message : String(e);
    throw new Error(
      `B站投稿列表触发风控（${seriesError}）；缓存 WBI 读取也失败（${wbiError}）`
    );
  }
}

// 直连（series/WBI）全部失败时的兜底：走 RSSHub 公共实例的 bilibili 路由
async function fetchBilibiliItemsViaRsshub(
  mid: string,
  env: Env
): Promise<ParsedItem[]> {
  const mirrorUrl = `${getRsshubBaseUrl(env)}/bilibili/user/video/${mid}`;
  const res = await fetchWithRetry(mirrorUrl, 1, 20000);

  if (!res.ok) {
    throw new Error(`RSSHub 镜像 HTTP ${res.status}`);
  }

  const items = parseFeed(await res.text());
  if (items.length === 0) {
    throw new Error("RSSHub 镜像返回 0 条");
  }

  return items;
}

// ---------- 来源头像补抓 ----------

// B站空间页 HTML 里的 "face":"..." 字段；JSON 内斜杠转义为 \/，需还原。
// Cloudflare 机房 IP 抓空间页大概率 412，失败一律返回 null，属预期。
async function fetchBilibiliAvatar(mid: string): Promise<string | null> {
  try {
    const res = await fetch(`https://space.bilibili.com/${mid}`, {
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent": BILI_UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!res.ok) return null;

    const html = await res.text();
    const match = html.match(/"face":"([^"]+)"/);
    if (!match) return null;

    const url = match[1].replace(/\\\//g, "/");
    return url.startsWith("https://") ? url : null;
  } catch {
    return null;
  }
}

// YouTube 频道页 HTML 里的第一个 yt3.ggpht.com 地址即频道头像
async function fetchYoutubeAvatar(channelId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}`, {
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent": BILI_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!res.ok) return null;

    const html = await res.text();
    const match = html.match(/https:\/\/yt3\.ggpht\.com\/[^"\\&\s]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

// RSS 等无平台头像概念的来源：不发请求，用站点 favicon
function faviconAvatar(feedUrl: string): string | null {
  try {
    const host = new URL(feedUrl).hostname;
    if (!host) return null;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=128`;
  } catch {
    return null;
  }
}

// 总入口：按平台分发，禁止跨平台兜底（bilibili/youtube 抓不到就 null，绝不退到 favicon）
async function fetchSourceAvatar(source: FeedSource): Promise<string | null> {
  try {
    if (source.platform === "bilibili") {
      const mid = source.feed_url?.match(/\/(\d+)(?:[/?#]|$)/)?.[1];
      return mid ? await fetchBilibiliAvatar(mid) : null;
    }
    if (source.platform === "youtube") {
      const chId = source.feed_url?.match(/(UC[\w-]{20,})/)?.[1];
      return chId ? await fetchYoutubeAvatar(chId) : null;
    }
    return faviconAvatar(source.feed_url);
  } catch {
    return null;
  }
}

// 抓取失败时把错误回写到网站（写不进就算了，不影响本地日志）
async function reportSourceError(
  base: string,
  authHeaders: Record<string, string>,
  sourceId: string,
  error: string
): Promise<void> {
  try {
    await fetch(`${base}/api/feed/items`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ source_id: sourceId, items: [], error }),
    });
  } catch {
    // 上报失败不处理
  }
}

async function cleanupDismissed(
  base: string,
  authHeaders: Record<string, string>,
): Promise<string> {
  try {
    const response = await fetch(`${base}/api/feed/cleanup`, {
      method: "POST",
      headers: authHeaders,
    });

    const payload = (await response.json().catch(() => ({}))) as {
      deleted?: number;
      error?: string;
    };

    if (!response.ok) {
      return (
        `清理 dismissed 失败 HTTP ${response.status}` +
        (payload.error ? `: ${payload.error}` : "")
      );
    }

    return `清理 dismissed ${payload.deleted ?? 0} 条`;
  } catch (error) {
    return `清理 dismissed 异常: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function syncAll(env: Env): Promise<string> {
  const base = env.LZHE_BASE_URL.replace(/\/+$/, "");
  const authHeaders = { "x-api-key": env.LZHE_API_KEY };

  // 1. 先清理超过 7 天的 dismissed
  const logs: string[] = [];
  logs.push(await cleanupDismissed(base, authHeaders));

  // 2. 拉取启用的来源列表
  const res = await fetch(`${base}/api/feed/sources`, {
    headers: authHeaders,
  });

  if (!res.ok) {
    throw new Error(`拉取来源列表失败: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    sources?: FeedSource[];
  };

  const sources = data.sources ?? [];

  if (sources.length === 0) {
    logs.push("没有启用的来源，无事可做");
    return logs.join("\n");
  }

  for (const source of sources) {
    try {
      let items: ParsedItem[];

      if (source.platform === "bilibili") {
        if (!source.feed_url) {
          const msg = "B站来源缺少 feed_url";
          logs.push(`[${source.name}] ${msg}`);
          await reportSourceError(base, authHeaders, source.id, msg);
          continue;
        }

        const mid = source.feed_url.match(/\/(\d+)(?:[/?#]|$)/)?.[1];
        if (!mid) {
          const msg = "无法从 feed_url 解析 B站 UID";
          logs.push(`[${source.name}] ${msg}`);
          await reportSourceError(base, authHeaders, source.id, msg);
          continue;
        }

        if (!env.BILI_SESSDATA) {
          throw new Error("未配置 BILI_SESSDATA（B站 Cookie），WBI 兜底链路不可用");
        }

        try {
          items = await fetchBilibiliItems(mid, env.BILI_SESSDATA);
        } catch (directError) {
          const directMsg =
            directError instanceof Error ? directError.message : String(directError);

          try {
            items = await fetchBilibiliItemsViaRsshub(mid, env);
          } catch (mirrorError) {
            const mirrorMsg =
              mirrorError instanceof Error ? mirrorError.message : String(mirrorError);
            throw new Error(
              `B站抓取失败；直连=${directMsg}；RSSHub镜像=${mirrorMsg}`
            );
          }
        }
      } else if (source.platform === "youtube") {
        // 官方 feed 优先（部署到 Cloudflare 后网络可用），失败走社区镜像兜底
        const chId = source.feed_url.match(/(UC[\w-]{20,})/)?.[1];
        if (!chId) {
          const msg = "无法从 feed_url 解析 YouTube channel_id";
          logs.push(`[${source.name}] ${msg}`);
          await reportSourceError(base, authHeaders, source.id, msg);
          continue;
        }
        const official = `https://www.youtube.com/feeds/videos.xml?channel_id=${chId}`;
        const mirror =
          `${getRsshubBaseUrl(env)}/youtube/channel/${chId}`;
        let feedRes: Response | null = null;
        try {
          const r = await fetchWithRetry(official, 1, 20000);
          if (r.ok) feedRes = r;
        } catch {
          // 官方不可达，走镜像
        }
        if (!feedRes) {
          try {
            const r = await fetchWithRetry(mirror);
            if (r.ok) feedRes = r;
          } catch {
            // 镜像也不可达
          }
        }
        if (!feedRes) {
          const msg = "YouTube 官方 feed 和镜像均不可达";
          logs.push(`[${source.name}] ${msg}`);
          await reportSourceError(base, authHeaders, source.id, msg);
          continue;
        }
        items = parseFeed(await feedRes.text());
      } else if (source.platform === "xiaohongshu") {
        const uid = source.feed_url?.match(
          /\/user\/profile\/([0-9a-f]{24})/
        )?.[1];
        if (!uid) {
          const msg = "无法从小红书链接解析 uid";
          logs.push(`[${source.name}] ${msg}`);
          await reportSourceError(base, authHeaders, source.id, msg);
          continue;
        }

        // 镜像不稳定：单次抓取 + 最多 1 次重试，错误里带 HTTP 状态码
        const xhsRes = await fetchWithRetry(
          `${getRsshubBaseUrl(env)}/xiaohongshu/user/${uid}/notes`,
          2,
          20000
        );
        if (!xhsRes.ok) {
          const msg = `小红书镜像抓取失败 HTTP ${xhsRes.status}`;
          logs.push(`[${source.name}] ${msg}`);
          await reportSourceError(base, authHeaders, source.id, msg);
          continue;
        }
        items = parseFeed(await xhsRes.text());
      } else {
        if (!source.feed_url) {
          const msg = "RSS 来源缺少 feed_url";
          logs.push(`[${source.name}] ${msg}`);
          await reportSourceError(base, authHeaders, source.id, msg);
          continue;
        }

        const feedRes = await fetchWithRetry(source.feed_url);
        if (!feedRes.ok) {
          const msg = `拉取 RSS 失败 HTTP ${feedRes.status}`;
          logs.push(`[${source.name}] ${msg}`);
          await reportSourceError(base, authHeaders, source.id, msg);
          continue;
        }
        items = parseFeed(await feedRes.text());
      }

      if (items.length === 0) {
        logs.push(`[${source.name}] 解析出 0 条，跳过`);
        continue;
      }

      // 缺头像的来源顺手补抓（失败返回 null，绝不影响条目同步）
      const avatarUrl = source.avatar_url
        ? null
        : await fetchSourceAvatar(source);

      const pushRes = await fetch(`${base}/api/feed/items`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify(
          avatarUrl
            ? { source_id: source.id, items, avatar_url: avatarUrl }
            : { source_id: source.id, items }
        ),
      });
      const result = (await pushRes.json().catch(() => ({}))) as {
        inserted?: number;
        skipped_duplicates?: number;
      };

      if (!pushRes.ok) {
        const msg =
          `推送失败 HTTP ${pushRes.status}: ${JSON.stringify(result)}`;
        logs.push(`[${source.name}] ${msg}`);
        await reportSourceError(base, authHeaders, source.id, msg);
        continue;
      }

      logs.push(
        `[${source.name}] 新入库 ${result.inserted ?? "?"} 条` +
          `（跳过重复 ${result.skipped_duplicates ?? "?"}）`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logs.push(`[${source.name}] 异常: ${msg}`);
      await reportSourceError(base, authHeaders, source.id, msg);
    }
  }

  return logs.join("\n");
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const apiKey = request.headers.get("x-api-key")?.trim() ?? "";
    const authorization = request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim() ?? "";

    const authorized = apiKey === env.LZHE_API_KEY || authorization === env.LZHE_API_KEY;

    if (url.pathname === "/sync" && authorized) {
      try {
        const log = await syncAll(env);
        return new Response(log, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (e) {
        console.error("sync error:", e);

        return new Response(
          `同步失败: ${
            e instanceof Error
              ? `${e.message}\n${e.stack ?? ""}`
              : String(e)
          }`,
          { status: 500 }
        );
      }
    }

    return new Response(
      "feed-worker 运行中。手动触发：GET /sync + x-api-key / Authorization: Bearer"
    );
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(
      syncAll(env).then(
        (log) => console.log(log),
        (e) => console.error("定时同步失败:", e)
      )
    );
  },
} satisfies ExportedHandler<Env>;