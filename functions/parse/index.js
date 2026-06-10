/**
 * 腾讯云 CloudBase 云函数 - 社交媒体内容提取
 *
 * 部署步骤：
 * 1. 安装 CLI: npm i -g @cloudbase/cli
 * 2. 登录: tcb login
 * 3. 在 cloudbaserc.json 中填写你的环境ID
 * 4. 部署函数: tcb fn deploy parse
 * 5. 部署静态网站: tcb hosting deploy ./ -e <envId>
 *
 * 注意：此文件是 api/parse.js 的 CloudBase 适配版
 * 两者逻辑一致，更新时需要同步修改
 */

// 如需更新同步，请直接复制 api/parse.js 中以下标记之间的代码
// === CORE_START === 到 === CORE_END ===
// 然后替换 handler 函数为 CloudBase 格式（见文件底部）

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

class CookieJar {
  constructor() { this.map = new Map(); }
  setFromHeaders(headers) {
    const raw = typeof headers.get === "function" ? headers.get("set-cookie") : headers["set-cookie"];
    if (!raw) return;
    const cookies = Array.isArray(raw) ? raw : [raw];
    for (const c of cookies) {
      const semi = c.indexOf(";"), pair = semi > 0 ? c.substring(0, semi) : c;
      const eq = pair.indexOf("=");
      if (eq > 0) this.map.set(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
    }
  }
  toString() { return [...this.map].map(([k, v]) => `${k}=${v}`).join("; "); }
}

function pickFirst(arr, idx = 0) {
  if (!arr || !Array.isArray(arr) || !arr.length) return "";
  return arr[idx] || arr[0] || "";
}

function extractUrlParams(url) {
  const params = {};
  try { for (const [k, v] of new URL(url).searchParams) params[k] = v; } catch {
    const q = url.split("?")[1];
    if (q) for (const p of q.split("&")) { const eq = p.indexOf("="); if (eq > 0) params[p.substring(0, eq)] = decodeURIComponent(p.substring(eq + 1)); }
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

function detectPlatform(url) {
  if (/douyin\.com|iesdouyin\.com/i.test(url)) return "douyin";
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return "xiaohongshu";
  return null;
}

async function resolveShortLink(shortUrl, logs) {
  try {
    const resp = await fetch(shortUrl, { redirect: "follow", headers: { "User-Agent": MOBILE_UA, "Accept-Language": "zh-CN,zh;q=0.9" } });
    if (resp.url && resp.url !== shortUrl) return resp.url;
  } catch (e) { logs.push("follow重定向失败: " + e.message); }
  try {
    const resp = await fetch(shortUrl, { redirect: "manual", headers: { "User-Agent": MOBILE_UA } });
    const loc = resp.headers.get("location");
    if (loc) return loc.startsWith("http") ? loc : "https://www.douyin.com" + loc;
    const html = await resp.text();
    const m = html.match(/https?:\/\/[^"'\s]*(?:douyin|xiaohongshu|iesdouyin)\.com[^"'\s]*/i);
    if (m) return m[0];
  } catch (e) { logs.push("manual重定向失败: " + e.message); }
  throw new Error("短链接重定向失败");
}

function extractRENDER_DATA(html) {
  const m = html.match(/<script[^>]*id="RENDER_DATA"[^>]*>([^<]+)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
}

function extractInitState(html) {
  for (const re of [/window\.__INITIAL_STATE__\s*=\s*(\{.+?\});?\s*(?:window|<\/script)/s, /__INITIAL_STATE__\s*=\s*(\{[^;]+)/]) {
    const m = html.match(re); if (m) { try { return JSON.parse(m[1]); } catch {} }
  }
  const m2 = html.match(/__INITIAL_STATE__\s*=\s*({[\s\S]+?})\s*\n\s*<\/script>/);
  if (m2) { try { return JSON.parse(m2[1].replace(/\\u002F/g, "/").replace(/\\u0026/g, "&")); } catch {} }
  return null;
}

function extractRouterData(html) {
  for (const re of [/window\._ROUTER_DATA\s*=\s*(\{.+?\});?\s*<\/script>/s, /_ROUTER_DATA\s*=\s*(\{[^;]+})/]) {
    const m = html.match(re); if (m) { try { return JSON.parse(m[1]); } catch {} }
  }
  return null;
}

function deepFind(obj, targetKeys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 10) return null;
  for (const k of targetKeys) { if (obj[k]) return obj; }
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val)) { for (const item of val) { const f = deepFind(item, targetKeys, depth + 1); if (f) return f; } }
    else if (val && typeof val === "object") { const f = deepFind(val, targetKeys, depth + 1); if (f) return f; }
  }
  return null;
}

// ===== 抖音解析 =====
async function parseDouyin(inputUrl, logs) {
  let shareUrl = inputUrl;
  if (/v\.douyin\.com/i.test(shareUrl)) { logs.push("抖音: 跟踪短链接..."); shareUrl = await resolveShortLink(shareUrl, logs); logs.push(`抖音: ${shareUrl.substring(0, 80)}...`); }

  let awemeId = null;
  let m;
  m = shareUrl.match(/\/video\/(\d+)/); if (m) awemeId = m[1];
  m = shareUrl.match(/\/note\/(\d+)/); if (m) awemeId = m[1];
  m = shareUrl.match(/modal_id=(\d+)/); if (m) awemeId = m[1];
  m = shareUrl.match(/aweme_id=(\d+)/); if (m) awemeId = m[1];
  m = shareUrl.match(/item_id=(\d+)/); if (m) awemeId = m[1];
  m = shareUrl.match(/(\d{17,20})/); if (m) awemeId = m[1];
  if (!awemeId) throw new Error("抖音: 无法识别视频ID");
  logs.push(`抖音: 视频ID ${awemeId}`);

  const params = extractUrlParams(shareUrl);

  // 策略1: API
  try {
    logs.push("抖音: 策略1 - API...");
    const jar = new CookieJar();
    try { const pr = await fetch(shareUrl, { redirect: "follow", headers: { "User-Agent": MOBILE_UA } }); jar.setFromHeaders(pr.headers); } catch {}
    let apiUrl = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}&aid=6383`;
    if (params.did) apiUrl += `&did=${encodeURIComponent(params.did)}`;
    if (params.iid) apiUrl += `&iid=${encodeURIComponent(params.iid)}`;
    const resp = await fetch(apiUrl, { headers: { "User-Agent": MOBILE_UA, Referer: shareUrl, Accept: "application/json", Cookie: jar.toString() } });
    const data = await resp.json();
    logs.push(`抖音: status_code=${data.status_code}`);
    if (data.status_code === 0 && data.item_list?.length) return formatDy(data.item_list[0]);
    throw new Error(`status_code=${data.status_code}`);
  } catch (e) { logs.push(`抖音: 策略1失败 - ${e.message}`); }

  // 策略2: HTML
  try {
    logs.push("抖音: 策略2 - HTML...");
    const resp = await fetch(shareUrl, { redirect: "follow", headers: { "User-Agent": MOBILE_UA, Accept: "text/html,*/*", "Accept-Language": "zh-CN,zh;q=0.9" } });
    const html = await resp.text(); logs.push(`抖音: HTML长度 ${html.length}`);
    let data = extractRENDER_DATA(html) || extractRouterData(html) || extractInitState(html);
    if (data) { const item = deepFind(data, ["aweme_id", "video", "images", "play_addr"]); if (item) return formatDy(item); }
    throw new Error("HTML中未找到");
  } catch (e) { logs.push(`抖音: 策略2失败 - ${e.message}`); }

  throw new Error("抖音: 所有策略失败");
}

function formatDy(item) {
  const hasImg = item.images && Array.isArray(item.images) && item.images.length > 0;
  const r = { platform: "douyin", type: hasImg ? "image" : "video", id: item.aweme_id, desc: item.desc || "", author: { nickname: item.author?.nickname || "未知", uid: item.author?.unique_id || item.author?.short_id || "", avatar: pickFirst(item.author?.avatar_thumb?.url_list) || pickFirst(item.author?.avatar_medium?.url_list) || "" }, stats: { likes: item.statistics?.digg_count || 0, comments: item.statistics?.comment_count || 0, shares: item.statistics?.share_count || 0 } };
  if (hasImg) { r.images = item.images.map(i => ({ url: pickFirst(i.origin_url?.url_list) || pickFirst(i.url_list) || "", thumb: pickFirst(i.url_list, 1) || pickFirst(i.url_list) || "" })); r.cover = r.images[0]?.thumb || ""; }
  else { const vid = item.video; if (!vid) throw new Error("无视频"); const uri = vid.play_addr?.uri || vid.playAddr?.uri || ""; const vId = uri.replace(/^vid:\/\//i, ""); r.videoUrl = vId ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${vId}&ratio=1080p&line=0` : (pickFirst(vid.download_addr?.url_list) || pickFirst(vid.play_addr?.url_list) || ""); r.videoUrl = r.videoUrl.replace(/watermark=1/gi, "watermark=0"); r.duration = vid.duration || 0; r.cover = pickFirst(vid.cover?.url_list) || pickFirst(vid.origin_cover?.url_list) || ""; }
  if (item.music?.title) r.music = { title: item.music.title, author: item.music.author || item.music.author_name || "" };
  return r;
}

// ===== 小红书解析 =====
async function parseXiaohongshu(inputUrl, logs) {
  let url = inputUrl;
  if (/xhslink\.com/i.test(url)) { logs.push("小红书: 跟踪短链接..."); url = await resolveShortLink(url, logs); if (!url) throw new Error("短链接重定向失败"); logs.push(`小红书: ${url.substring(0, 60)}...`); }

  let noteId = null;
  let m;
  m = url.match(/\/explore\/([a-zA-Z0-9_-]+)/); if (m) noteId = m[1];
  m = url.match(/\/discovery\/item\/([a-zA-Z0-9_-]+)/); if (m) noteId = m[1];
  if (!noteId) { const parts = url.replace(/[?#].*$/, "").split("/").filter(Boolean); noteId = parts[parts.length - 1]; }
  if (!noteId || noteId.length < 8) throw new Error(`无法识别笔记ID (${noteId})`);
  logs.push(`小红书: 笔记ID ${noteId}`);

  // 策略1: HTML
  try {
    logs.push("小红书: 策略1 - HTML...");
    const urls = [`https://www.xiaohongshu.com/explore/${noteId}`, `https://www.xiaohongshu.com/discovery/item/${noteId}`];
    for (const pageUrl of urls) {
      const resp = await fetch(pageUrl, { headers: { "User-Agent": MOBILE_UA, Accept: "text/html,*/*", "Accept-Language": "zh-CN,zh;q=0.9" } });
      if (!resp.ok) continue;
      const html = await resp.text(); logs.push(`小红书: HTML长度 ${html.length}`);
      const initState = extractInitState(html);
      if (initState) {
        const noteData = initState.note || initState.noteDetail || initState.noteInfo;
        if (noteData) { logs.push("小红书: 找到note数据"); return formatXhs(noteData); }
        const found = deepFind(initState, ["noteId", "imageList", "video", "title", "user"]);
        if (found) { logs.push("小红书: 深度搜索找到"); return formatXhs(found); }
      }
    }
    throw new Error("HTML中未找到笔记");
  } catch (e) { logs.push(`小红书: 策略1失败 - ${e.message}`); }

  // 策略2: API
  try {
    logs.push("小红书: 策略2 - API...");
    const resp = await fetch(`https://edith.xiaohongshu.com/api/sns/web/v1/feed?source_note_id=${noteId}`, { headers: { "User-Agent": MOBILE_UA, Accept: "application/json", "Accept-Language": "zh-CN,zh;q=0.9", Referer: `https://www.xiaohongshu.com/explore/${noteId}` } });
    const data = await resp.json(); logs.push(`小红书: success=${data.success}`);
    if (data.success && data.data) { const nd = data.data.items?.[0]?.note_card || data.data.note || data.data; if (nd) return formatXhs(nd); }
    throw new Error("API格式不符");
  } catch (e) { logs.push(`小红书: 策略2失败 - ${e.message}`); }

  throw new Error("小红书: 所有策略失败");
}

function formatXhs(noteData) {
  const isVideo = noteData.type === "video";
  const r = { platform: "xiaohongshu", type: isVideo ? "video" : "image", id: noteData.noteId || noteData.note_id || "", title: noteData.title || noteData.displayTitle || "", desc: noteData.desc || noteData.description || "", author: { nickname: noteData.user?.nickname || noteData.user?.nickName || "未知", uid: noteData.user?.userId || noteData.user?.user_id || "", avatar: noteData.user?.avatar || noteData.user?.avatarImage || "" }, stats: { likes: parseInt(noteData.interactInfo?.likedCount) || 0, comments: parseInt(noteData.interactInfo?.commentCount) || 0, shares: parseInt(noteData.interactInfo?.sharedCount) || 0, collects: parseInt(noteData.interactInfo?.collectedCount) || 0 } };
  if (isVideo) { const stream = (noteData.video?.media || noteData.video?.videoResource || {}).stream || {}; const h264 = stream.h264 || stream.h_264 || []; r.videoUrl = h264[0]?.masterUrl || h264[0]?.master_url || noteData.video?.media?.downloadAddr || ""; r.duration = noteData.video?.duration || 0; r.cover = noteData.video?.image?.firstFrameFileid ? `https://sns-webpic-qc.xhscdn.com/${noteData.video.image.firstFrameFileid}` : (noteData.imageList?.[0]?.url || ""); }
  else { const imgs = noteData.imageList || noteData.image_list || []; r.images = imgs.map(i => ({ url: i.url || i.urlDefault || "", thumb: i.urlPre || i.url_pre || i.url || "" })); r.cover = r.images[0]?.thumb || ""; r.imageCount = r.images.length; }
  if (noteData.tagList) r.tags = noteData.tagList.map(t => t.name || t.tagName || t).filter(Boolean).slice(0, 10);
  return r;
}

// ===== CloudBase 入口 =====
exports.main = async (event, context) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const httpMethod = event.httpMethod || "POST";
  if (httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  let body = event.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const url = (body && body.url) || "";

  if (!url?.trim()) return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: "请粘贴分享链接" }) };

  const cleanUrl = extractUrlFromText(url.trim());
  if (!cleanUrl) return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: "无法识别链接" }) };

  const platform = detectPlatform(cleanUrl);
  if (!platform) return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: "不支持的平台" }) };

  const logs = [];
  try {
    logs.push(`平台: ${platform}`);
    const result = platform === "douyin" ? await parseDouyin(cleanUrl, logs) : await parseXiaohongshu(cleanUrl, logs);
    logs.push("解析成功");
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: { ...result, _logs: logs } }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message, debug: logs }) };
  }
};
