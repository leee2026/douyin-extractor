/**
 * 抖音无水印提取 - 后端解析函数 (v2)
 * 多策略并行：API 直调 → 页面解析 → 第三方接口
 */

// ===== 请求头配置 =====
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ===== 简易 Cookie 管理器 =====
class CookieJar {
  constructor() {
    this.map = new Map();
  }
  setFromHeaders(headers) {
    const setCookie = headers.get("set-cookie");
    if (!setCookie) return;
    // Vercel 的 fetch 可能返回逗号拼接的多条 cookie
    const parts = setCookie.split(",");
    for (const part of parts) {
      const eq = part.indexOf("=");
      const semi = part.indexOf(";");
      if (eq > 0) {
        const key = part.substring(0, eq).trim();
        const val = semi > eq ? part.substring(eq + 1, semi).trim() : part.substring(eq + 1).trim();
        this.map.set(key, val);
      }
    }
  }
  get cookieString() {
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

  // 从可能混有文字的分享文案中提取纯链接
  let cleanUrl = extractUrlFromText(inputUrl);
  if (!cleanUrl) {
    return res.status(400).json({ success: false, error: "无法从文本中识别抖音链接" });
  }

  // 记录每个步骤的日志，出错时返回给前端方便排查
  const logs = [];

  try {
    const result = await parseDouyinLink(cleanUrl, logs);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    console.error("解析失败:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "解析失败，请稍后重试",
      debug: logs, // 返回执行日志帮助排查
    });
  }
}

// ===== 核心解析流程 =====
async function parseDouyinLink(inputUrl, logs) {
  // 第一步：解析目标 URL（跟进短链接重定向）
  let targetUrl = inputUrl;
  if (/v\.douyin\.com/i.test(targetUrl)) {
    logs.push("检测到短链接，正在跟踪重定向...");
    targetUrl = await resolveShortLink(targetUrl, logs);
    logs.push(`重定向结果: ${targetUrl}`);
  }

  // 第二步：提取 aweme_id
  const awemeId = extractAwemeId(targetUrl);
  if (!awemeId) {
    logs.push(`未能从 URL 提取 ID: ${targetUrl}`);
    throw new Error(
      "无法识别视频ID，请检查链接。\n\n支持格式：\n• v.douyin.com 短链接\n• douyin.com/video/数字ID\n• douyin.com/note/数字ID"
    );
  }
  logs.push(`已提取视频ID: ${awemeId}`);

  // 第三步：依次尝试多种解析策略
  let itemData = null;
  let lastError = null;

  // 策略1: iesdouyin.com 分享 API（对海外访问最友好）
  try {
    logs.push("策略1: 尝试 iesdouyin.com 分享API...");
    itemData = await strategyIesdouyinApi(awemeId, logs);
  } catch (e) {
    lastError = e;
    logs.push(`策略1 失败: ${e.message}`);
  }

  // 策略2: 抖音主站 API
  if (!itemData) {
    try {
      logs.push("策略2: 尝试 douyin.com 主站API...");
      itemData = await strategyDouyinApi(awemeId, logs);
    } catch (e) {
      lastError = e;
      logs.push(`策略2 失败: ${e.message}`);
    }
  }

  // 策略3: 解析抖音页面 HTML（模拟真实浏览器访问）
  if (!itemData) {
    try {
      logs.push("策略3: 尝试解析页面HTML...");
      itemData = await strategyPageHtml(awemeId, targetUrl, logs);
    } catch (e) {
      lastError = e;
      logs.push(`策略3 失败: ${e.message}`);
    }
  }

  if (!itemData) {
    throw new Error(
      `所有解析策略均失败，可能原因：\n` +
        `1. 抖音接口升级（需更新解析逻辑）\n` +
        `2. 该视频/图集已被删除或设为私密\n` +
        `3. Vercel 服务器被抖音屏蔽\n` +
        `最后错误: ${lastError?.message || "未知"}`
    );
  }

  logs.push("解析成功，正在格式化数据...");
  return formatResponse(itemData);
}

// ===== 重定向解析（改用 resp.url 自动跟随） =====
async function resolveShortLink(shortUrl, logs) {
  // 方案A：自动跟随重定向，resp.url 就是最终地址
  try {
    const resp = await fetch(shortUrl, {
      redirect: "follow",
      headers: { "User-Agent": MOBILE_UA },
    });
    const finalUrl = resp.url;
    if (finalUrl && finalUrl !== shortUrl && /douyin\.com/i.test(finalUrl)) {
      return finalUrl;
    }
  } catch (e) {
    logs.push(`自动重定向失败: ${e.message}`);
  }

  // 方案B：手动获取 Location 头
  try {
    const resp = await fetch(shortUrl, {
      redirect: "manual",
      headers: { "User-Agent": MOBILE_UA },
    });
    const location = resp.headers.get("location");
    if (location) {
      return location.startsWith("http") ? location : `https://www.douyin.com${location}`;
    }
  } catch (e) {
    logs.push(`手动重定向失败: ${e.message}`);
  }

  throw new Error("无法解析短链接，链接可能已失效");
}

// ===== aweme_id 提取 =====
function extractAwemeId(url) {
  let m;
  m = url.match(/\/video\/(\d+)/); if (m) return m[1];
  m = url.match(/\/note\/(\d+)/);  if (m) return m[1];
  m = url.match(/modal_id=(\d+)/); if (m) return m[1];
  m = url.match(/aweme_id=(\d+)/); if (m) return m[1];
  m = url.match(/item_id=(\d+)/);  if (m) return m[1];
  m = url.match(/(\d{17,20})/);    if (m) return m[1];
  return null;
}

// ===== 从混合文本中提取抖音链接 =====
function extractUrlFromText(text) {
  // 抖音短链接
  let m = text.match(/https?:\/\/v\.douyin\.com\/[a-zA-Z0-9\/?=&_%.-]+/);
  if (m) return m[0];
  // 标准链接
  m = text.match(/https?:\/\/(?:www\.)?douyin\.com\/(?:video|note|user)\/[a-zA-Z0-9\/?=&_%.-]+/);
  if (m) return m[0];
  // iesdouyin
  m = text.match(/https?:\/\/(?:www\.)?iesdouyin\.com\/[a-zA-Z0-9\/?=&_%.-]+/);
  if (m) return m[0];
  // 如果文本本身就像合法 URL（以 http 开头）
  if (/^https?:\/\//.test(text.trim()) && /douyin\.com|iesdouyin\.com/i.test(text)) {
    return text.trim();
  }
  return null;
}

// ===== 策略1: iesdouyin 分享 API =====
async function strategyIesdouyinApi(awemeId, logs) {
  const jar = new CookieJar();

  // 先访问 douyin 首页获取基础 cookie
  try {
    const homeResp = await fetch("https://www.douyin.com/", {
      headers: { "User-Agent": MOBILE_UA },
    });
    jar.setFromHeaders(homeResp.headers);
  } catch {}

  // API 请求
  const apiUrl = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}&aid=6383`;
  const resp = await fetch(apiUrl, {
    headers: {
      "User-Agent": MOBILE_UA,
      Referer: "https://www.douyin.com/",
      Accept: "application/json",
      Cookie: jar.cookieString,
    },
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const data = await resp.json();
  logs.push(`iesdouyin 返回 status_code: ${data.status_code}`);

  if (data.status_code !== 0) throw new Error(`status_code=${data.status_code}`);
  if (!data.item_list?.length) throw new Error("item_list 为空，内容可能不存在");

  return data.item_list[0];
}

// ===== 策略2: 抖音主站 API =====
async function strategyDouyinApi(awemeId, logs) {
  const jar = new CookieJar();

  // 先访问视频页面获取 cookie 和必要 token
  const pageUrl = `https://www.douyin.com/video/${awemeId}`;
  const pageResp = await fetch(pageUrl, {
    headers: { "User-Agent": DESKTOP_UA },
  });
  jar.setFromHeaders(pageResp.headers);
  const pageHtml = await pageResp.text();

  // 从页面提取 msToken（抖音防爬 token）
  let msToken = "";
  const msMatch = pageHtml.match(/msToken[=:]\s*["']?([a-zA-Z0-9_-]+)["']?/);
  if (msMatch) msToken = msMatch[1];

  // 从页面提取 ttwid
  let ttwid = "";
  const twMatch = pageHtml.match(/ttwid[=:]\s*["']?([a-zA-Z0-9_-]+)["']?/);
  if (twMatch) ttwid = twMatch[1];

  if (msToken) jar.map.set("msToken", msToken);
  if (ttwid) jar.map.set("ttwid", ttwid);

  const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=6383&cookie_enabled=true&device_platform=webapp&browser_name=Safari`;

  const resp = await fetch(apiUrl, {
    headers: {
      "User-Agent": MOBILE_UA,
      Referer: `https://www.douyin.com/video/${awemeId}`,
      Accept: "application/json",
      Cookie: jar.cookieString,
    },
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const data = await resp.json();
  logs.push(`douyin API code: ${data.status_code}, has_detail: ${!!data.aweme_detail}`);

  if (!data.aweme_detail) throw new Error("aweme_detail 为空");

  return data.aweme_detail;
}

// ===== 策略3: 解析页面 HTML 内嵌数据 =====
async function strategyPageHtml(awemeId, fullUrl, logs) {
  const isNote = /\/note\//.test(fullUrl);
  const pageUrl = isNote
    ? `https://www.douyin.com/note/${awemeId}`
    : `https://www.douyin.com/video/${awemeId}`;

  const resp = await fetch(pageUrl, {
    headers: {
      "User-Agent": DESKTOP_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
  });

  if (!resp.ok) throw new Error(`页面 HTTP ${resp.status}`);

  const html = await resp.text();

  // 尝试从 RENDER_DATA 中提取数据
  const renderMatch = html.match(/<script[^>]*id="RENDER_DATA"[^>]*>([^<]+)<\/script>/);
  if (renderMatch) {
    try {
      const decoded = decodeURIComponent(renderMatch[1]);
      const renderData = JSON.parse(decoded);
      logs.push("成功解析 RENDER_DATA");

      // 尝试多种路径提取视频数据
      const appData = renderData["app"] || renderData || {};

      // 路径1: app.videoDetail 或 app.awemeDetail
      let detail = appData["videoDetail"] || appData["awemeDetail"];

      // 路径2: 可能在 serverParams 中
      if (!detail && appData["serverParams"]) {
        const sp = appData["serverParams"];
        detail = sp["aweme_detail"] || sp["videoDetail"] || sp;
      }

      // 路径3: 直接从顶层找
      if (!detail && renderData["aweme_detail"]) {
        detail = renderData["aweme_detail"];
      }

      if (detail) {
        return normalizeDetailData(detail);
      }

      logs.push("RENDER_DATA 已解析但未找到视频数据，结构: " + Object.keys(appData).join(", "));
    } catch (e) {
      logs.push(`RENDER_DATA 解析失败: ${e.message}`);
    }
  }

  // 尝试从 window.__INITIAL_STATE__ 提取
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});?\s*<\/script>/s);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      logs.push("成功解析 __INITIAL_STATE__");
      const detail = state?.videoDetail || state?.video?.detail || state;
      if (detail && detail.aweme_id) {
        return normalizeDetailData(detail);
      }
    } catch (e) {
      logs.push(`__INITIAL_STATE__ 解析失败: ${e.message}`);
    }
  }

  // 尝试从其他 script 标签中找 JSON 数据
  const jsonMatches = html.match(/<script[^>]*type="application\/json"[^>]*>([^<]+)<\/script>/g);
  if (jsonMatches) {
    for (const match of jsonMatches) {
      try {
        const inner = match.replace(/<[^>]*>/g, "");
        const data = JSON.parse(inner);
        const detail = data?.aweme_detail || data?.video || data?.item_list?.[0];
        if (detail?.aweme_id) {
          logs.push("从 application/json script 中提取成功");
          return normalizeDetailData(detail);
        }
      } catch {}
    }
  }

  throw new Error("页面 HTML 中未找到视频数据");
}

// 将各种格式的数据规范化为统一格式
function normalizeDetailData(detail) {
  // 如果已经是标准格式（有 video 或 images 字段），直接返回
  if (detail.video || detail.images) return detail;

  // 可能包含 aweme_detail 子字段
  if (detail.aweme_detail) return detail.aweme_detail;

  // 可能包含在 video 下
  if (detail.videoInfo) {
    return {
      aweme_id: detail.aweme_id,
      desc: detail.desc || detail.share_info?.share_desc,
      author: detail.author || detail.author_info,
      statistics: detail.statistics || detail.stats,
      video: detail.videoInfo,
      images: detail.images || detail.image_list,
      music: detail.music || detail.music_info,
    };
  }

  return detail;
}

// ===== 数据格式化 =====
function formatResponse(item) {
  const hasImages = item.images && Array.isArray(item.images) && item.images.length > 0;
  const type = hasImages ? "image" : "video";

  const result = {
    type,
    aweme_id: item.aweme_id || item.awemeId,
    desc: item.desc || item.description || "",
    author: {
      nickname: item.author?.nickname || item.authorInfo?.nickname || "未知用户",
      unique_id: item.author?.unique_id || item.author?.short_id || item.authorInfo?.unique_id || "",
      avatar:
        pickFirst(item.author?.avatar_thumb?.url_list) ||
        pickFirst(item.author?.avatar_medium?.url_list) ||
        pickFirst(item.author?.avatar_thumb?.urlList) ||
        "",
    },
    statistics: {
      likes: item.statistics?.digg_count || item.statistics?.like_count || 0,
      comments: item.statistics?.comment_count || 0,
      shares: item.statistics?.share_count || 0,
    },
  };

  if (type === "image") {
    result.images = item.images.map((img) => ({
      url: pickFirst(img.origin_url?.url_list) || pickFirst(img.url_list) || pickFirst(img.urlList) || "",
      thumbnail: pickFirst(img.url_list, 1) || pickFirst(img.urlList, 1) || "",
      width: img.width || 0,
      height: img.height || 0,
    }));
    result.image_count = result.images.length;
    result.cover = result.images[0]?.thumbnail || result.images[0]?.url || "";
  } else {
    const video = item.video || item.videoInfo;
    if (!video) throw new Error("数据中未找到视频信息");

    result.video = {
      url: getBestVideoUrl(video, item),
      duration: video.duration || video.durationMs || 0,
      cover: pickFirst(video.cover?.url_list) || pickFirst(video.origin_cover?.url_list) || "",
    };

    // 多清晰度
    const bitRates = video.bit_rate || video.bitRate || [];
    if (bitRates.length > 0) {
      result.video.qualities = bitRates
        .map((br) => ({
          label: br.gear_name || br.gearName || "",
          url: pickFirst(br.play_addr?.url_list) || pickFirst(br.playAddr?.urlList) || "",
        }))
        .filter((q) => q.label && q.url);
    }
  }

  if (item.music) {
    result.music = {
      title: item.music.title || "",
      author: item.music.author || item.music.author_name || "",
    };
  }

  return result;
}

function pickFirst(arr, index = 0) {
  if (!arr || !Array.isArray(arr) || !arr.length) return "";
  return arr[index] || arr[0] || "";
}

// ===== 获取最优无水印视频地址 =====
function getBestVideoUrl(video, item) {
  // 优先级: download > h264 > play > 拼接
  const candidates = [
    video.download_addr,
    video.downloadAddr,
    video.play_addr_h264,
    video.playAddrH264,
    video.play_addr,
    video.playAddr,
  ];

  for (const cand of candidates) {
    const url = pickFirst(cand?.url_list) || pickFirst(cand?.urlList);
    if (url) return url.replace(/watermark=1/gi, "watermark=0");
  }

  // 拼接
  const uri = video.play_addr?.uri || video.playAddr?.uri || "";
  const vidMatch = uri.match(/[a-z0-9]{15,}/i);
  if (vidMatch) {
    return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${vidMatch[0]}&ratio=1080p&line=0`;
  }

  throw new Error("无法获取视频播放地址");
}
