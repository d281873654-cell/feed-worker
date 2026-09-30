import { XMLParser } from "fast-xml-parser";

interface Env {
  LZHE_API_KEY: string;
  LZHE_BASE_URL: string;
  BILI_SESSDATA: string;
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
  isArray: (name) => ["item", "entry", "link"].includes(name),
});

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

async function fetchWithRetry(
  url: string,
  attempts = 2,
  timeoutMs = 60000
): Promise<Response> {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return res;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("fetch failed");
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

async function md5hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("MD5", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getMixinKey(orig: string): string {
  return WBI_MIXIN_KEY_ENC_TABLE.slice(0, 32)
    .map((i) => orig[i])
    .join("");
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

async function fetchBilibiliItems(mid: string, sessdata: string): Promise<ParsedItem[]> {
  const buvid = await getBilibiliCookie();
  const cookie = buvid ? `${buvid}; SESSDATA=${sessdata}` : `SESSDATA=${sessdata}`;
  const apiHeaders = {
    "User-Agent": BILI_UA,
    "Accept-Language": "zh-CN,zh;q=0.9",
    Accept: "application/json, text/plain, */*",
    Referer: `https://space.bilibili.com/${mid}`,
    Cookie: cookie,
  };

  const navRes = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    signal: AbortSignal.timeout(20000),
    headers: apiHeaders,
  });
  const navText = await navRes.text();
  let nav: any;
  try {
    nav = JSON.parse(navText);
  } catch {
    throw new Error(`B站 WAF 拦截（nav 返回 HTML 前 80 字符: ${navText.slice(0, 80)}）`);
  }
  const imgUrl: string = nav?.data?.wbi_img?.img_url ?? "";
  const subUrl: string = nav?.data?.wbi_img?.sub_url ?? "";
  const imgKey = imgUrl.split("/").pop()?.split(".")[0] ?? "";
  const subKey = subUrl.split("/").pop()?.split(".")[0] ?? "";
  const mixinKey = getMixinKey(imgKey + subKey);
  if (!mixinKey) throw new Error("获取 wbi 公钥失败");

  const params: Record<string, string> = {
    mid,
    ps: "30",
    pn: "1",
    order: "pubdate",
    platform: "web",
    dm_img_list: "[]",
    dm_img_str:
      "V2ViR0wgMS4wIChPcGVuR0wgRVMgMy4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQpKSBDaHJvbWUvMTIwLjAuMC4wIFNhZmFyaS8xMjAuMC4wLjA=",
    dm_cover_img_str: "QUJDREVGRw==",
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
    wts: Math.floor(Date.now() / 1000).toString(),
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const w_rid = await md5hex(query + mixinKey);

  const apiUrl = `https://api.bilibili.com/x/space/wbi/arc/search?${query}&w_rid=${w_rid}`;
  const res = await fetch(apiUrl, {
    signal: AbortSignal.timeout(20000),
    headers: apiHeaders,
  });
  const dataText = await res.text();
  let data: any;
  try {
    data = JSON.parse(dataText);
  } catch {
    throw new Error(
      `B站 WAF 拦截（arc/search 返回 HTML 前 80 字符: ${dataText.slice(0, 80)}）`
    );
  }
  if (data.code !== 0) {
    throw new Error(`B站 API 错误 code=${data.code} msg=${data.message}`);
  }

  const vlist: any[] = data?.data?.list?.vlist ?? [];
  return vlist
    .map((v) => ({
      title: String(v.title ?? "").trim(),
      url: `https://www.bilibili.com/video/${v.bvid}`,
      summary: cleanSummary(String(v.description ?? "")),
      published_at: v.created ? new Date(v.created * 1000).toISOString() : null,
    }))
    .filter((i) => i.title && i.url);
}

// ---------------------------------------------------------------------------

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

async function syncAll(env: Env): Promise<string> {
  const base = env.LZHE_BASE_URL.replace(/\/+$/, "");
  const authHeaders = { "x-api-key": env.LZHE_API_KEY };

  // 1. 拉取启用的来源列表
  const res = await fetch(`${base}/api/feed/sources`, { headers: authHeaders });
  if (!res.ok) throw new Error(`拉取来源列表失败: HTTP ${res.status}`);
  const data = (await res.json()) as { sources?: FeedSource[] };
  const sources = data.sources ?? [];

  if (sources.length === 0) return "没有启用的来源，无事可做";

  // 2. 逐个源抓取、解析、推送
  const logs: string[] = [];
  for (const source of sources) {
    try {
      let items: ParsedItem[];

      if (source.platform === "bilibili") {
        const mid = source.feed_url.match(/\/(\d+)(?:[/?#]|$)/)?.[1];
        if (!mid) {
          const msg = "无法从 feed_url 解析 B站 UID";
          logs.push(`[${source.name}] ${msg}`);
          await reportSourceError(base, authHeaders, source.id, msg);
          continue;
        }
        if (!env.BILI_SESSDATA) {
          throw new Error("未配置 BILI_SESSDATA（B站登录 Cookie），无法抓取该源");
        }
        items = await fetchBilibiliItems(mid, env.BILI_SESSDATA!);
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
        const mirror = `https://rsshub.ktachibana.party/youtube/channel/${chId}`;
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
      } else {
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

      const pushRes = await fetch(`${base}/api/feed/items`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ source_id: source.id, items }),
      });
      const result = (await pushRes.json().catch(() => ({}))) as {
        inserted?: number;
        skipped_duplicates?: number;
      };

      if (!pushRes.ok) {
        logs.push(
          `[${source.name}] 推送失败 HTTP ${pushRes.status}: ${JSON.stringify(result)}`
        );
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
    if (
      url.pathname === "/sync" &&
      url.searchParams.get("key") === env.LZHE_API_KEY
    ) {
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
      "feed-worker 运行中。手动触发：GET /sync?key=你的API_KEY"
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