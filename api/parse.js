/**
 * 抖音无水印提取 - 后端解析函数 (v3)
 *
 * 核心思路：
 * 1. 短链接 → 重定向到 iesdouyin 分享页（这是给海外看的页面！）
 * 2. 从分享页 URL 提取 did/iid 等设备参数
 * 3. 用这些参数模拟真实浏览器调用 API
 * 4. 如果 API 被封，直接从分享页 HTML 里抠数据
 */

// ===== 请求头 =====
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ===== Cookie 管理 =====
class CookieJar {
  constructor() {
    this.map = new Map();
  }
  setFromHeaders(headers) {
    // headers 可能是 Headers 对象或普通对象
    const setCookie = typeof headers.get === "function"
      ? headers.get("set-cookie")
      : headers["set-cookie"];
    if (!setCookie) return;
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookieStr of cookies) {
      const semi = cookieStr.indexOf(";");
      const pair = semi > 0 ? cookieStr.substring(0, semi) : cookieStr;
      const eq = pair.indexOf("=");
      if (eq > 0) {
        this.map.set(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
      }
    }
  }
  toString() {
    return Array.from(this.map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

// ===== 主入口 =====
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "仅支持 POST 请求" });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ success: false, error: "请输入抖音分享链接" });
  }

  const inputUrl = url.trim();
  if (!/douyin\.com|iesdouyin\.com/i.test(inputUrl)) {
    return res.status(400).json({ success: false, error: "请输入有效的抖音链接" });
  }

  const cleanUrl = extractUrlFromText(inputUrl);
  if (!cleanUrl) {
    return res.status(400).json({ success: false, error: "无法从文本中识别抖音链接" });
  }

  const logs = [];
  try {
    const result = await parseDouyinLink(cleanUrl, logs);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error("解析失败:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "解析失败",
      debug: logs,
    });
  }
}

// ===== 主流程 =====
async function parseDouyinLink(inputUrl, logs) {
  // 1. 短链接 → 重定向到分享页
  let sharePageUrl = inputUrl;
  if (/v\.douyin\.com/i.test(sharePageUrl)) {
    logs.push("跟踪短链接重定向...");
    sharePageUrl = await resolveShortLink(sharePageUrl, logs);
    logs.push(`分享页: ${sharePageUrl.substring(0, 100)}...`);
  }

  // 2. 提取 ID
  const awemeId = extractAwemeId(sharePageUrl);
  if (!awemeId) {
    throw new Error("无法识别视频ID，请检查链接格式");
  }
  logs.push(`视频ID: ${awemeId}`);

  // 3. 从分享页 URL 提取设备参数
  const urlParams = extractUrlParams(sharePageUrl);
  if (urlParams.did) logs.push(`提取到 did: ${urlParams.did.substring(0, 20)}...`);
  if (urlParams.iid) logs.push(`提取到 iid: ${urlParams.iid.substring(0, 20)}...`);

  // 4. 依次尝试策略
  let itemData = null;
  let lastError = null;

  // 策略1: 用分享页参数调 API（最关键：did/iid 是设备凭证）
  try {
    logs.push("策略1: 带设备参数的分享API...");
    itemData = await strategyIesdouyinWithParams(awemeId, sharePageUrl, urlParams, logs);
  } catch (e) {
    lastError = e;
    logs.push(`策略1 失败: ${e.message}`);
  }

  // 策略2: 直接抓分享页 HTML 扒数据
  if (!itemData) {
    try {
      logs.push("策略2: 解析分享页HTML...");
      itemData = await strategySharePageHtml(sharePageUrl, awemeId, logs);
    } catch (e) {
      lastError = e;
      logs.push(`策略2 失败: ${e.message}`);
    }
  }

  // 策略3: douyin 主站页面
  if (!itemData) {
    try {
      logs.push("策略3: douyin主站页面...");
      itemData = await strategyDouyinPage(awemeId, logs);
    } catch (e) {
      lastError = e;
      logs.push(`策略3 失败: ${e.message}`);
    }
  }

  if (!itemData) {
    throw new Error(
      `所有策略均失败。\n最后错误: ${lastError?.message || "未知"}\n\n` +
      `可能原因：\n` +
      `1. Vercel 海外服务器被抖音屏蔽（最常见）\n` +
      `2. 视频已删除或私密\n` +
      `3. 需更换部署区域`
    );
  }

  logs.push("解析成功，格式化数据...");
  return formatResponse(itemData);
}

// ===== 短链接解析 =====
async function resolveShortLink(shortUrl, logs) {
  // 方法1：跟随重定向
  try {
    const resp = await fetch(shortUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": MOBILE_UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    if (resp.url && resp.url !== shortUrl && /douyin\.com/i.test(resp.url)) {
      return resp.url;
    }
  } catch (e) {
    logs.push(`follow 失败: ${e.message}`);
  }

  // 方法2：手动取 Location
  try {
    const resp = await fetch(shortUrl, {
      redirect: "manual",
      headers: { "User-Agent": MOBILE_UA },
    });
    const loc = resp.headers.get("location");
    if (loc) {
      return loc.startsWith("http") ? loc : `https://www.douyin.com${loc}`;
    }
    // 有时在 HTML body 里的 a 标签
    const html = await resp.text();
    const m = html.match(/https?:\/\/[^"'\s]*douyin\.com[^"'\s]*/i);
    if (m) return m[0];
  } catch (e) {
    logs.push(`manual 失败: ${e.message}`);
  }

  throw new Error("短链接重定向失败，链接可能已失效");
}

// ===== 从 URL 提取参数 =====
function extractUrlParams(url) {
  const params = {};
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams) {
      params[k] = v;
    }
  } catch {
    // 非标准 URL，手动解析
    const q = url.split("?")[1];
    if (q) {
      for (const pair of q.split("&")) {
        const eq = pair.indexOf("=");
        if (eq > 0) params[pair.substring(0, eq)] = decodeURIComponent(pair.substring(eq + 1));
      }
    }
  }
  return params;
}

// ===== aweme_id 提取 =====
function extractAwemeId(url) {
  let m;
  m = url.match(/\/video\/(\d+)/); if (m) return m[1];
  m = url.match(/\/note\/(\d+)/);  if (m) return m[1];
  m = url.match(/modal_id=(\d+)/); if (m) return m[1];
  m = url.match(/aweme_id=(\d+)/); if (m) return m[1];
  m = url.match(/item_id=(\d+)/);  if (m) return m[1];
  m = url.match(/[?&]id=(\d+)/);   if (m) return m[1];
  m = url.match(/(\d{17,20})/);    if (m) return m[1];
  return null;
}

// ===== 从混合文本提取链接 =====
function extractUrlFromText(text) {
  let m;
  m = text.match(/https?:\/\/v\.douyin\.com\/[a-zA-Z0-9\/?=&_%.-]+/);
  if (m) return m[0];
  m = text.match(/https?:\/\/(?:www\.)?douyin\.com\/(?:video|note|user)\/[a-zA-Z0-9\/?=&_%.-]+/);
  if (m) return m[0];
  m = text.match(/https?:\/\/(?:www\.)?iesdouyin\.com\/[a-zA-Z0-9\/?=&_%.-]+/);
  if (m) return m[0];
  if (/^https?:\/\//.test(text.trim()) && /douyin\.com|iesdouyin\.com/i.test(text)) {
    return text.trim();
  }
  return null;
}

// ===== 策略1: iesdouyin API（带设备参数） =====
async function strategyIesdouyinWithParams(awemeId, sharePageUrl, urlParams, logs) {
  const jar = new CookieJar();

  // 先访问分享页拿 cookie（模拟浏览器首次访问）
  try {
    const pageResp = await fetch(sharePageUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": MOBILE_UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    jar.setFromHeaders(pageResp.headers);
    logs.push(`分享页 HTTP ${pageResp.status}, cookies: ${jar.map.size} 个`);
  } catch (e) {
    logs.push(`分享页访问失败: ${e.message}`);
  }

  // 构建 API URL，带上设备参数
  let apiUrl = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}&aid=6383`;
  if (urlParams.did) apiUrl += `&did=${encodeURIComponent(urlParams.did)}`;
  if (urlParams.iid) apiUrl += `&iid=${encodeURIComponent(urlParams.iid)}`;

  const resp = await fetch(apiUrl, {
    headers: {
      "User-Agent": MOBILE_UA,
      Referer: sharePageUrl,
      Accept: "application/json",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Cookie: jar.toString(),
    },
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const text = await resp.text();
  if (!text || text.length < 10) throw new Error("API 返回空响应");

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    logs.push(`API 返回非 JSON (前100字): ${text.substring(0, 100)}`);
    throw new Error("API 返回非 JSON 数据");
  }

  logs.push(`status_code: ${data.status_code}`);

  if (data.status_code !== 0) {
    // 11110 = 缺少签名，其他错误码
    throw new Error(`status_code=${data.status_code}`);
  }

  if (!data.item_list?.length) throw new Error("item_list 为空");

  return data.item_list[0];
}

// ===== 策略2: 解析分享页 HTML =====
async function strategySharePageHtml(sharePageUrl, awemeId, logs) {
  const resp = await fetch(sharePageUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": MOBILE_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const html = await resp.text();
  logs.push(`分享页HTML 长度: ${html.length}`);

  // 尝试所有已知的数据嵌入模式
  const extractors = [
    extractRENDER_DATA,
    extractInitState,
    extractRouterData,
    extractJsonScripts,
    extractAnyLargeJson,
  ];

  for (const extractor of extractors) {
    try {
      const detail = extractor(html, logs);
      if (detail) {
        logs.push(`提取成功: ${extractor.name}`);
        return normalizeDetailData(detail);
      }
    } catch {}
  }

  // 如果所有提取都失败，打印 HTML 片段帮助调试
  const snippets = [];
  for (const pattern of ["RENDER_DATA", "__INITIAL_STATE__", "video", "aweme", "play_addr"]) {
    const idx = html.indexOf(pattern);
    if (idx >= 0) {
      snippets.push(`...${html.substring(Math.max(0, idx - 20), idx + 80)}...`);
    }
  }
  if (snippets.length > 0) {
    logs.push(`HTML 关键词片段:\n${snippets.join("\n")}`);
  } else {
    logs.push("HTML 中未找到任何已知关键词 (RENDER_DATA/__INITIAL_STATE__/video/aweme/play_addr)");
  }

  throw new Error("分享页 HTML 中未找到视频数据");
}

function extractRENDER_DATA(html, logs) {
  const m = html.match(/<script[^>]*id="RENDER_DATA"[^>]*>([^<]+)<\/script>/);
  if (!m) return null;
  try {
    const decoded = decodeURIComponent(m[1]);
    const data = JSON.parse(decoded);
    // 导航到视频数据
    const app = data.app || data;
    return app.videoDetail || app.awemeDetail || app["serverParams"]?.aweme_detail || null;
  } catch {}
  return null;
}

function extractInitState(html, logs) {
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.+?\});?\s*(?:window|<\/script)/s);
  if (!m) {
    // 尝试更宽松的匹配
    const m2 = html.match(/__INITIAL_STATE__\s*=\s*(\{[^;]+\})/);
    if (!m2) return null;
    try {
      return JSON.parse(m2[1]);
    } catch {
      return null;
    }
  }
  try {
    const state = JSON.parse(m[1]);
    return state?.videoDetail || state?.awemeDetail || null;
  } catch {}
  return null;
}

function extractRouterData(html, logs) {
  const patterns = [
    /window\._ROUTER_DATA\s*=\s*(\{.+?\});?\s*<\/script>/s,
    /_ROUTER_DATA\s*=\s*(\{[^;]+\})/,
    /window\.__NUXT__\s*=\s*(\{.+?\});?\s*<\/script>/s,
    /window\.__DATA__\s*=\s*(\{.+?\});?\s*<\/script>/s,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {}
    }
  }
  return null;
}

function extractJsonScripts(html, logs) {
  // 找所有 <script type="application/json" id="...">
  const re = /<script[^>]*type="application\/json"[^>]*id="([^"]*)"[^>]*>([^<]+)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[2]);
      const detail = data?.aweme_detail || data?.video || data?.item_list?.[0];
      if (detail?.aweme_id) {
        logs.push(`JSON script id="${m[1]}" 包含视频数据`);
        return detail;
      }
    } catch {}
  }
  return null;
}

function extractAnyLargeJson(html, logs) {
  // 查找任何包含 video/play_addr/aweme 关键词的大 JSON 对象
  // 在所有 <script> 标签中搜索
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRe.exec(html)) !== null) {
    const content = scriptMatch[1];
    if (!content.includes("aweme") && !content.includes("play_addr")) continue;
    // 尝试找 JSON 对象
    const jsonRe = /\{[\s\S]*"(?:aweme_id|play_addr|video|images)"[\s\S]*\}/g;
    let jsonMatch;
    while ((jsonMatch = jsonRe.exec(content)) !== null) {
      try {
        const data = JSON.parse(jsonMatch[0]);
        if (data.aweme_id || data.item_list || data.video || data.images) {
          logs.push("从 script 标签中提取到大 JSON 对象");
          return data.item_list?.[0] || data;
        }
      } catch {}
    }
  }
  return null;
}

// ===== 策略3: douyin 主站页面 =====
async function strategyDouyinPage(awemeId, logs) {
  const pageUrl = `https://www.douyin.com/video/${awemeId}`;
  const resp = await fetch(pageUrl, {
    headers: {
      "User-Agent": DESKTOP_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const html = await resp.text();
  logs.push(`douyin页面HTML 长度: ${html.length}`);

  // 尝试相同的提取器
  const extractors = [extractRENDER_DATA, extractInitState, extractRouterData, extractJsonScripts];
  for (const extractor of extractors) {
    try {
      const detail = extractor(html, logs);
      if (detail) {
        logs.push(`douyin页面提取成功: ${extractor.name}`);
        return normalizeDetailData(detail);
      }
    } catch {}
  }

  throw new Error("douyin 页面中未找到视频数据");
}

// 标准化不同格式的数据 + 深度搜索
function normalizeDetailData(detail, depth = 0) {
  if (!detail || typeof detail !== "object" || depth > 8) return detail;

  // 直接匹配：有 aweme_id + video 或 images
  if (detail.aweme_id && (detail.video || detail.images)) return detail;

  // 常见嵌套路径（优先级从高到低）
  const directPaths = [
    "aweme_detail",
    "awemeDetail",
    "itemStruct",
    "videoDetail",
    "videoData",
    "aweme_info",
    "video_info",
    "item_detail",
    "detail",
    "data",
  ];

  for (const path of directPaths) {
    if (detail[path]) {
      const found = normalizeDetailData(detail[path], depth + 1);
      if (found && (found.video || found.images)) return found;
    }
  }

  // 递归搜索所有子对象
  for (const key of Object.keys(detail)) {
    const val = detail[key];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const found = normalizeDetailData(val, depth + 1);
      if (found && (found.video || found.images)) return found;
    }
  }

  // 兜底：原样返回（让 formatResponse 报更精确的错误）
  return detail;
}

// ===== 数据格式化 =====
function formatResponse(item) {
  // 调试：记录数据结构的顶层 key
  const keys = Object.keys(item || {}).join(", ");
  const hasVideo = !!item.video;
  const hasImages = !!(item.images && Array.isArray(item.images) && item.images.length > 0);

  // 如果顶层没有 video/images，再尝试深挖一次
  if (!hasVideo && !hasImages) {
    const deep = normalizeDetailData(item);
    if (deep && deep !== item && (deep.video || deep.images)) {
      item = deep;
    }
  }

  const hasImagesNow = item.images && Array.isArray(item.images) && item.images.length > 0;
  const type = hasImagesNow ? "image" : "video";

  const result = {
    type,
    aweme_id: item.aweme_id,
    desc: item.desc || "",
    author: {
      nickname: item.author?.nickname || "未知",
      unique_id: item.author?.unique_id || item.author?.short_id || "",
      avatar: pickFirst(item.author?.avatar_thumb?.url_list) ||
        pickFirst(item.author?.avatar_medium?.url_list) || "",
    },
    statistics: {
      likes: item.statistics?.digg_count || item.statistics?.like_count || 0,
      comments: item.statistics?.comment_count || 0,
      shares: item.statistics?.share_count || 0,
    },
  };

  if (type === "image") {
    result.images = item.images.map((img) => ({
      url: pickFirst(img.origin_url?.url_list) || pickFirst(img.url_list) || "",
      thumbnail: pickFirst(img.url_list, 1) || pickFirst(img.url_list) || "",
      width: img.width || 0,
      height: img.height || 0,
    }));
    result.image_count = result.images.length;
  } else {
    const video = item.video || item.videoInfo;
    if (!video) {
      // 调试：列出可用字段
      const available = Object.keys(item).filter(k => typeof item[k] !== "object" || item[k] === null);
      const objKeys = Object.keys(item).filter(k => typeof item[k] === "object" && item[k] !== null);
      throw new Error(
        `数据中未找到视频信息。\n` +
        `顶层字段: ${keys}\n` +
        `对象字段: ${objKeys.join(", ") || "无"}`
      );
    }

    result.video = {
      url: getBestVideoUrl(video),
      duration: video.duration || 0,
      cover: pickFirst(video.cover?.url_list) ||
        pickFirst(video.origin_cover?.url_list) || "",
    };
  }

  if (item.music?.title) {
    result.music = {
      title: item.music.title,
      author: item.music.author || item.music.author_name || "",
    };
  }

  return result;
}

function pickFirst(arr, index = 0) {
  if (!arr || !Array.isArray(arr) || !arr.length) return "";
  return arr[index] || arr[0] || "";
}

function getBestVideoUrl(video) {
  const sources = [
    video.download_addr,
    video.downloadAddr,
    video.play_addr_h264,
    video.playAddrH264,
    video.play_addr_265,
    video.play_addr,
    video.playAddr,
  ];
  for (const src of sources) {
    const url = pickFirst(src?.url_list) || pickFirst(src?.urlList);
    if (url) return url.replace(/watermark=1/gi, "watermark=0");
  }
  throw new Error("无可用视频地址");
}
