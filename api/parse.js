/**
 * 社交媒体无水印提取 - 后端解析函数 (v4)
 * 支持：抖音 + 小红书
 * 部署：Vercel / 腾讯云 CloudBase 均可
 *
 * 核心思路：
 * 1. 识别平台 → 路由到对应解析器
 * 2. 短链接跟随重定向 → 获取真实URL
 * 3. 多策略尝试：API → 页面HTML内嵌数据
 * 4. 返回结构化数据
 */

// ===== 通用请求头 =====
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ===== Cookie 管理 =====
class CookieJar {
  constructor() { this.map = new Map(); }
  setFromHeaders(headers) {
    const raw = typeof headers.get === "function" ? headers.get("set-cookie") : headers["set-cookie"];
    if (!raw) return;
    const cookies = Array.isArray(raw) ? raw : [raw];
    for (const c of cookies) {
      const semi = c.indexOf(";");
      const pair = semi > 0 ? c.substring(0, semi) : c;
      const eq = pair.indexOf("=");
      if (eq > 0) this.map.set(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
    }
  }
  toString() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

// ===== 工具函数 =====
function pickFirst(arr, idx = 0) {
  if (!arr || !Array.isArray(arr) || !arr.length) return "";
  return arr[idx] || arr[0] || "";
}

function extractUrlParams(url) {
  const params = {};
  try {
    for (const [k, v] of new URL(url).searchParams) params[k] = v;
  } catch {
    const q = url.split("?")[1];
    if (q) {
      for (const p of q.split("&")) {
        const eq = p.indexOf("=");
        if (eq > 0) params[p.substring(0, eq)] = decodeURIComponent(p.substring(eq + 1));
      }
    }
  }
  return params;
}

function extractUrlFromText(text) {
  let m;
  m = text.match(/https?:\/\/v\.douyin\.com\/[a-zA-Z0-9/?=&_%.-]+/); if (m) return m[0];
  m = text.match(/https?:\/\/(?:www\.)?douyin\.com\/(?:video|note|user)\/[a-zA-Z0-9/?=&_%.-]+/); if (m) return m[0];
  m = text.match(/https?:\/\/(?:www\.)?iesdouyin\.com\/[a-zA-Z0-9/?=&_%.-]+/); if (m) return m[0];
  m = text.match(/https?:\/\/(?:www\.)?xiaohongshu\.com\/[a-zA-Z0-9/?=&_%.-]+/); if (m) return m[0];
  m = text.match(/https?:\/\/xhslink\.com\/[a-zA-Z0-9/?=&_%.-]+/); if (m) return m[0];
  if (/^https?:\/\//.test(text.trim())) return text.trim();
  return null;
}

function formatCount(n) {
  const num = parseInt(n) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1) + "w";
  if (num >= 1000) return (num / 1000).toFixed(1) + "k";
  return String(num);
}

// ===== 平台识别 =====
function detectPlatform(url) {
  if (/douyin\.com|iesdouyin\.com/i.test(url)) return "douyin";
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return "xiaohongshu";
  return null;
}

// ===== 通用：跟随短链接重定向 =====
async function resolveShortLink(shortUrl, logs) {
  // 方法1：自动跟随重定向
  try {
    const resp = await fetch(shortUrl, {
      redirect: "follow",
      headers: { "User-Agent": MOBILE_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    const final = resp.url;
    if (final && final !== shortUrl) return final;
  } catch (e) { logs.push(`follow重定向失败: ${e.message}`); }

  // 方法2：手动取 Location
  try {
    const resp = await fetch(shortUrl, {
      redirect: "manual",
      headers: { "User-Agent": MOBILE_UA },
    });
    const loc = resp.headers.get("location");
    if (loc) return loc.startsWith("http") ? loc : `https://www.douyin.com${loc}`;
    // HTML 中查找
    const html = await resp.text();
    const m = html.match(/https?:\/\/[^"'\s]*(?:douyin|xiaohongshu|iesdouyin)\.com[^"'\s]*/i);
    if (m) return m[0];
  } catch (e) { logs.push(`manual重定向失败: ${e.message}`); }

  throw new Error("短链接重定向失败，链接可能已失效");
}

// ===== 通用：HTML 数据提取器 =====
function extractRENDER_DATA(html) {
  const m = html.match(/<script[^>]*id="RENDER_DATA"[^>]*>([^<]+)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
}

function extractInitState(html) {
  // 尝试多种模式匹配 __INITIAL_STATE__
  for (const re of [
    /window\.__INITIAL_STATE__\s*=\s*(\{.+?\});?\s*(?:window|<\/script)/s,
    /__INITIAL_STATE__\s*=\s*(\{[^;]+)/
  ]) {
    const m = html.match(re);
    if (m) {
      try { return JSON.parse(m[1]); } catch {}
    }
  }
  // 更宽松的匹配：找 __INITIAL_STATE__ 后面的 JSON 替换后内容
  // 小红书页面用的是 JSON.parse(JSON.stringify()) 替换后的格式
  const m2 = html.match(/__INITIAL_STATE__\s*=\s*({[\s\S]+?})\s*\n\s*<\/script>/);
  if (m2) {
    try {
      // 尝试替换 unicode 转义
      const cleaned = m2[1].replace(/\\u002F/g, "/").replace(/\\u0026/g, "&");
      return JSON.parse(cleaned);
    } catch {}
  }
  return null;
}

function extractRouterData(html) {
  for (const re of [
    /window\._ROUTER_DATA\s*=\s*(\{.+?\});?\s*<\/script>/s,
    /_ROUTER_DATA\s*=\s*(\{[^;]+\})/,
    /window\.__NUXT__\s*=\s*(\{.+?\});?\s*<\/script>/s,
  ]) {
    const m = html.match(re);
    if (m) {
      try { return JSON.parse(m[1]); } catch {}
    }
  }
  return null;
}

// 递归搜索嵌套对象中的目标字段
function deepFind(obj, targetKeys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 10) return null;
  // 直接检查
  for (const k of targetKeys) {
    if (obj[k]) return obj;
  }
  // 递归
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        const found = deepFind(item, targetKeys, depth + 1);
        if (found) return found;
      }
    } else if (val && typeof val === "object") {
      const found = deepFind(val, targetKeys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ===================================================================
//                        抖音解析模块
// ===================================================================
async function parseDouyin(inputUrl, logs) {
  // 1. 短链接 → 重定向
  let shareUrl = inputUrl;
  if (/v\.douyin\.com/i.test(shareUrl)) {
    logs.push("抖音: 跟踪短链接...");
    shareUrl = await resolveShortLink(shareUrl, logs);
    logs.push(`抖音: 分享页 ${shareUrl.substring(0, 80)}...`);
  }

  // 2. 提取 aweme_id
  let awemeId = null;
  let m;
  m = shareUrl.match(/\/video\/(\d+)/); if (m) awemeId = m[1];
  m = shareUrl.match(/\/note\/(\d+)/);  if (m) awemeId = m[1];
  m = shareUrl.match(/modal_id=(\d+)/); if (m) awemeId = m[1];
  m = shareUrl.match(/aweme_id=(\d+)/); if (m) awemeId = m[1];
  m = shareUrl.match(/item_id=(\d+)/);  if (m) awemeId = m[1];
  m = shareUrl.match(/(\d{17,20})/);    if (m) awemeId = m[1];
  if (!awemeId) throw new Error("抖音: 无法识别视频ID");
  logs.push(`抖音: 视频ID ${awemeId}`);

  // 3. 提取 URL 参数
  const params = extractUrlParams(shareUrl);

  // 4. 策略1：iesdouyin API（带设备参数 + cookie）
  try {
    logs.push("抖音: 策略1 - iesdouyin API...");
    const jar = new CookieJar();
    try {
      const pr = await fetch(shareUrl, { redirect: "follow", headers: { "User-Agent": MOBILE_UA } });
      jar.setFromHeaders(pr.headers);
    } catch {}

    let apiUrl = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}&aid=6383`;
    if (params.did) apiUrl += `&did=${encodeURIComponent(params.did)}`;
    if (params.iid) apiUrl += `&iid=${encodeURIComponent(params.iid)}`;

    const resp = await fetch(apiUrl, {
      headers: {
        "User-Agent": MOBILE_UA, Referer: shareUrl,
        Accept: "application/json", Cookie: jar.toString(),
      },
    });
    const data = await resp.json();
    logs.push(`抖音: API status_code=${data.status_code}`);
    if (data.status_code === 0 && data.item_list?.length) {
      return formatDouyinResponse(data.item_list[0]);
    }
    throw new Error(`status_code=${data.status_code}`);
  } catch (e) { logs.push(`抖音: 策略1失败 - ${e.message}`); }

  // 5. 策略2：解析分享页 HTML
  try {
    logs.push("抖音: 策略2 - 解析分享页HTML...");
    const resp = await fetch(shareUrl, {
      redirect: "follow",
      headers: { "User-Agent": MOBILE_UA, Accept: "text/html,*/*", "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    const html = await resp.text();
    logs.push(`抖音: HTML长度 ${html.length}`);

    // 尝试各种提取器
    let data = extractRENDER_DATA(html) || extractRouterData(html) || extractInitState(html);
    if (data) {
      logs.push(`抖音: 提取到页面数据`);
      // 深度搜索视频信息
      const item = deepFind(data, ["aweme_id", "video", "images", "play_addr"]);
      if (item) return formatDouyinResponse(item);
    }
    throw new Error("HTML中未找到视频数据");
  } catch (e) { logs.push(`抖音: 策略2失败 - ${e.message}`); }

  // 6. 策略3：尝试 douyin 主站页面
  try {
    logs.push("抖音: 策略3 - douyin主站...");
    const pageUrl = `https://www.douyin.com/video/${awemeId}`;
    const resp = await fetch(pageUrl, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "text/html,*/*", "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    const html = await resp.text();
    let data = extractRENDER_DATA(html) || extractInitState(html) || extractRouterData(html);
    if (data) {
      const item = deepFind(data, ["aweme_id", "video", "images", "play_addr"]);
      if (item) return formatDouyinResponse(item);
    }
    throw new Error("主站HTML中未找到视频数据");
  } catch (e) { logs.push(`抖音: 策略3失败 - ${e.message}`); }

  throw new Error("抖音: 所有策略均失败");
}

function formatDouyinResponse(item) {
  const hasImages = item.images && Array.isArray(item.images) && item.images.length > 0;
  const type = hasImages ? "image" : "video";
  const result = {
    platform: "douyin",
    type,
    id: item.aweme_id,
    desc: item.desc || "",
    author: {
      nickname: item.author?.nickname || "未知",
      uid: item.author?.unique_id || item.author?.short_id || "",
      avatar: pickFirst(item.author?.avatar_thumb?.url_list) ||
        pickFirst(item.author?.avatar_medium?.url_list) || "",
    },
    stats: {
      likes: item.statistics?.digg_count || item.statistics?.like_count || 0,
      comments: item.statistics?.comment_count || 0,
      shares: item.statistics?.share_count || 0,
    },
  };

  if (type === "image") {
    result.images = item.images.map((img) => ({
      url: pickFirst(img.origin_url?.url_list) || pickFirst(img.url_list) || "",
      thumb: pickFirst(img.url_list, 1) || pickFirst(img.url_list) || "",
    }));
    result.cover = result.images[0]?.thumb || "";
  } else {
    const vid = item.video;
    if (!vid) throw new Error("抖音数据中无视频");
    const uri = vid.play_addr?.uri || vid.playAddr?.uri || "";
    const videoId = uri.replace(/^vid:\/\//i, "");
    result.videoUrl = videoId
      ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${videoId}&ratio=1080p&line=0`
      : pickFirst(vid.download_addr?.url_list) || pickFirst(vid.play_addr?.url_list) || "";
    result.videoUrl = result.videoUrl.replace(/watermark=1/gi, "watermark=0");
    result.duration = vid.duration || 0;
    result.cover = pickFirst(vid.cover?.url_list) || pickFirst(vid.origin_cover?.url_list) || "";
  }

  if (item.music?.title) {
    result.music = { title: item.music.title, author: item.music.author || item.music.author_name || "" };
  }

  return result;
}

// ===================================================================
//                       小红书解析模块
// ===================================================================
async function parseXiaohongshu(inputUrl, logs) {
  // 1. 短链接 → 重定向
  let url = inputUrl;
  if (/xhslink\.com/i.test(url)) {
    logs.push("小红书: 跟踪短链接...");
    url = await resolveXhsShortLink(url, logs);
    if (!url) throw new Error("小红书短链接重定向失败");
    logs.push(`小红书: 跳转至 ${url.substring(0, 60)}...`);
  }

  // 2. 提取 note_id
  let noteId = null;
  let m;
  m = url.match(/\/explore\/([a-zA-Z0-9_-]+)/); if (m) noteId = m[1];
  m = url.match(/\/discovery\/item\/([a-zA-Z0-9_-]+)/); if (m) noteId = m[1];
  m = url.match(/\/note\/([a-zA-Z0-9_-]+)/); if (m) noteId = m[1];
  m = url.match(/note[_-]?[iI][dD][=:]?\s*["']?([a-zA-Z0-9_-]{10,30})["']?/); if (m) noteId = m[1];
  if (!noteId) {
    // 从 URL 路径最后一段提取
    const parts = url.replace(/[?#].*$/, "").split("/").filter(Boolean);
    noteId = parts[parts.length - 1];
  }
  if (!noteId || noteId.length < 8) throw new Error(`小红书: 无法识别笔记ID (${noteId})`);
  logs.push(`小红书: 笔记ID ${noteId}`);

  // 3. 策略1：抓取笔记页面解析 __INITIAL_STATE__
  try {
    logs.push("小红书: 策略1 - 解析页面HTML...");
    return await xhsStrategyHtml(noteId, logs);
  } catch (e) { logs.push(`小红书: 策略1失败 - ${e.message}`); }

  // 4. 策略2：尝试用 note_id 直接拼 API
  try {
    logs.push("小红书: 策略2 - 尝试API...");
    return await xhsStrategyApi(noteId, logs);
  } catch (e) { logs.push(`小红书: 策略2失败 - ${e.message}`); }

  throw new Error("小红书: 所有策略均失败");
}

async function resolveXhsShortLink(shortUrl, logs) {
  // xhslink.com 短链接跟随重定向
  try {
    const resp = await fetch(shortUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    if (resp.url && /xiaohongshu\.com/i.test(resp.url)) return resp.url;
  } catch { logs.push("小红书重定向: follow失败"); }

  // 手动
  try {
    const resp = await fetch(shortUrl, {
      redirect: "manual",
      headers: { "User-Agent": MOBILE_UA },
    });
    const loc = resp.headers.get("location");
    if (loc) return loc.startsWith("http") ? loc : `https://www.xiaohongshu.com${loc}`;
  } catch { logs.push("小红书重定向: manual失败"); }

  return null;
}

async function xhsStrategyHtml(noteId, logs) {
  // 尝试两个常见的URL格式
  const urls = [
    `https://www.xiaohongshu.com/explore/${noteId}`,
    `https://www.xiaohongshu.com/discovery/item/${noteId}`,
  ];

  let lastHtml = "";

  for (const pageUrl of urls) {
    try {
      const resp = await fetch(pageUrl, {
        headers: {
          "User-Agent": MOBILE_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      });
      if (!resp.ok) continue;

      const html = await resp.text();
      lastHtml = html;
      logs.push(`小红书: ${pageUrl.split("/").pop()} HTML长度 ${html.length}`);

      // 尝试提取 __INITIAL_STATE__
      const initState = extractInitState(html);
      if (initState) {
        logs.push(`小红书: 提取到 __INITIAL_STATE__, 顶层keys: ${Object.keys(initState).slice(0, 10).join(", ")}`);
        // 小红书的结构：note 或 noteDetail 在顶层
        const noteData = initState.note || initState.noteDetail || initState.noteInfo;
        if (noteData) {
          logs.push(`小红书: 找到 note 数据`);
          return formatXhsResponse(noteData);
        }
        // 深度搜索
        const found = deepFind(initState, ["noteId", "imageList", "video", "title", "user"]);
        if (found) {
          logs.push(`小红书: 深度搜索找到笔记数据`);
          return formatXhsResponse(found);
        }
        logs.push(`小红书: __INITIAL_STATE__ 中未找到note数据`);
      }

      // 尝试 RENDER_DATA（万一小红书也用这个）
      const renderData = extractRENDER_DATA(html);
      if (renderData) {
        logs.push(`小红书: 发现 RENDER_DATA`);
        const found = deepFind(renderData, ["noteId", "imageList", "note"]);
        if (found) return formatXhsResponse(found);
      }
    } catch (e) {
      logs.push(`小红书: ${pageUrl} 请求失败 - ${e.message}`);
    }
  }

  // 最后尝试：直接在HTML中找包含 noteId 的 JSON
  const noteIdPattern = new RegExp(`"noteId"\\s*:\\s*"${noteId}"[\\s\\S]{0,5000}`, "g");
  const idMatch = lastHtml.match(noteIdPattern);
  if (idMatch) {
    logs.push("小红书: HTML中找到了noteId引用（但完整JSON未解析成功）");
  }

  throw new Error("小红书页面HTML中未找到笔记数据");
}

async function xhsStrategyApi(noteId, logs) {
  // 尝试小红书的公开 note API
  const apiUrl = `https://edith.xiaohongshu.com/api/sns/web/v1/feed?source_note_id=${noteId}&note_id=${noteId}`;

  const resp = await fetch(apiUrl, {
    headers: {
      "User-Agent": MOBILE_UA,
      "Accept": "application/json",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Referer": `https://www.xiaohongshu.com/explore/${noteId}`,
      "Origin": "https://www.xiaohongshu.com",
    },
  });

  if (!resp.ok) throw new Error(`API HTTP ${resp.status}`);
  const data = await resp.json();
  logs.push(`小红书: API success=${data.success}, code=${data.code}`);

  if (data.success && data.data) {
    // data.data 可能包含 items 数组或直接是 note 数据
    const noteData = data.data.items?.[0]?.note_card || data.data.note || data.data;
    if (noteData) return formatXhsResponse(noteData);
  }

  throw new Error("API返回数据格式不符");
}

function formatXhsResponse(noteData) {
  const noteType = noteData.type || noteData.noteType || "normal";
  const isVideo = noteType === "video";
  const result = {
    platform: "xiaohongshu",
    type: isVideo ? "video" : "image",
    id: noteData.noteId || noteData.note_id || "",
    title: noteData.title || noteData.displayTitle || "",
    desc: noteData.desc || noteData.description || "",
    author: {
      nickname: noteData.user?.nickname || noteData.user?.nickName || noteData.author?.nickname || "未知",
      uid: noteData.user?.userId || noteData.user?.user_id || noteData.author?.userId || "",
      avatar: noteData.user?.avatar || noteData.user?.avatarImage || "",
    },
    stats: {
      likes: parseInt(noteData.interactInfo?.likedCount) || parseInt(noteData.likes) || 0,
      comments: parseInt(noteData.interactInfo?.commentCount) || parseInt(noteData.comments) || 0,
      shares: parseInt(noteData.interactInfo?.sharedCount) || parseInt(noteData.shares) || 0,
      collects: parseInt(noteData.interactInfo?.collectedCount) || parseInt(noteData.collects) || 0,
    },
  };

  if (isVideo) {
    // 视频笔记
    const videoMedia = noteData.video?.media || noteData.video?.videoResource || {};
    const stream = videoMedia.stream || {};
    // 优先 h264，其次 h265
    const h264 = stream.h264 || stream.h_264 || [];
    const h265 = stream.h265 || stream.h_265 || [];
    const bestStream = h264[0] || h265[0] || {};
    result.videoUrl = bestStream.masterUrl || bestStream.master_url || "";
    if (!result.videoUrl && noteData.video?.media?.downloadAddr) {
      result.videoUrl = noteData.video.media.downloadAddr;
    }
    result.duration = noteData.video?.duration || noteData.video?.videoDuration || 0;
    // 封面：用视频第一帧或第一张图
    result.cover = noteData.video?.image?.firstFrameFileid
      ? `https://sns-webpic-qc.xhscdn.com/${noteData.video.image.firstFrameFileid}`
      : (noteData.imageList?.[0]?.url || "");
  } else {
    // 图文笔记
    const images = noteData.imageList || noteData.image_list || noteData.images || [];
    result.images = images.map((img) => ({
      url: img.url || img.urlDefault || img.imageUrl || img.url_default || "",
      thumb: img.urlPre || img.url_pre || img.thumbnail || img.url || "",
      width: img.width || 0,
      height: img.height || 0,
    }));
    result.cover = result.images[0]?.thumb || "";
    result.imageCount = result.images.length;
  }

  // 标签
  if (noteData.tagList || noteData.tags) {
    const tags = noteData.tagList || noteData.tags || [];
    result.tags = tags.map(t => t.name || t.tagName || t).filter(Boolean).slice(0, 10);
  }

  return result;
}

// ===================================================================
//                         主入口
// ===================================================================
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "仅支持 POST" });

  const { url } = req.body || {};
  if (!url?.trim()) return res.status(400).json({ success: false, error: "请粘贴分享链接" });

  const cleanUrl = extractUrlFromText(url.trim());
  if (!cleanUrl) return res.status(400).json({ success: false, error: "无法从文本中识别链接。支持：抖音分享链接、小红书分享链接" });

  const platform = detectPlatform(cleanUrl);
  if (!platform) return res.status(400).json({ success: false, error: "不支持的平台。目前支持：抖音、小红书" });

  const logs = [];
  try {
    logs.push(`平台: ${platform}`);
    let result;
    if (platform === "douyin") {
      result = await parseDouyin(cleanUrl, logs);
    } else {
      result = await parseXiaohongshu(cleanUrl, logs);
    }
    logs.push("✅ 解析成功");
    return res.status(200).json({ success: true, data: { ...result, _logs: logs } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      error: err.message || "解析失败",
      debug: logs,
    });
  }
}

// 兼容 CloudBase 云函数导出
export { handler };
