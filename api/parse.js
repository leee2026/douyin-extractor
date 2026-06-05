/**
 * 抖音无水印提取 - 后端解析函数
 * 部署在 Vercel Serverless 上，作为中间层绕过 CORS 限制
 *
 * 工作流程：
 * 1. 接收抖音分享链接（短链接或完整链接）
 * 2. 如果是短链接，跟踪重定向获取真实 URL
 * 3. 提取视频/图集 ID (aweme_id)
 * 4. 调用抖音公开 API 获取无水印资源
 * 5. 返回结构化数据给前端
 */

// 请求头：模拟移动端浏览器，避免被反爬
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

/**
 * Vercel Serverless Function 入口
 */
export default async function handler(req, res) {
  // === CORS 配置 ===
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // 预检请求直接返回
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // 只接受 POST 请求
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "仅支持 POST 请求",
    });
  }

  // === 参数校验 ===
  const { url } = req.body || {};

  if (!url || typeof url !== "string" || !url.trim()) {
    return res.status(400).json({
      success: false,
      error: "请输入抖音分享链接",
    });
  }

  const inputUrl = url.trim();

  // 验证是否为抖音链接
  if (!/douyin\.com|iesdouyin\.com/i.test(inputUrl)) {
    return res.status(400).json({
      success: false,
      error: "请输入有效的抖音链接（包含 douyin.com）",
    });
  }

  // === 核心解析逻辑 ===
  try {
    const result = await parseDouyinLink(inputUrl);
    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    console.error("解析失败:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "解析失败，请稍后重试",
    });
  }
}

/**
 * 主解析流程
 */
async function parseDouyinLink(inputUrl) {
  let targetUrl = inputUrl;

  // 第一步：如果是短链接 (v.douyin.com)，先跟踪重定向
  if (/v\.douyin\.com/i.test(targetUrl)) {
    targetUrl = await followShortLink(targetUrl);
    console.log("重定向后地址:", targetUrl);
  }

  // 第二步：提取视频/图集 ID
  const awemeId = extractAwemeId(targetUrl);
  if (!awemeId) {
    throw new Error("无法从链接中识别视频ID，请检查链接是否正确。\n\n支持的链接格式：\n• v.douyin.com 短链接\n• douyin.com/video/...\n• douyin.com/note/...");
  }

  console.log("解析到 ID:", awemeId);

  // 第三步：调用抖音 API 获取详情
  const itemData = await fetchItemDetail(awemeId);

  // 第四步：格式化返回数据
  return formatResponse(itemData);
}

/**
 * 跟踪短链接重定向，获取真实 URL
 */
async function followShortLink(shortUrl) {
  const resp = await fetch(shortUrl, {
    redirect: "manual", // 不自动重定向，手动获取 Location
    headers: HEADERS,
  });

  // 获取 HTTP 302 重定向地址
  const location = resp.headers.get("location");
  if (location) {
    // 处理相对路径和绝对路径
    if (location.startsWith("http")) {
      return location;
    }
    return `https://www.douyin.com${location.startsWith("/") ? "" : "/"}${location}`;
  }

  // 部分短链接可能用 JS 跳转，尝试从响应体中提取
  try {
    const html = await resp.text();
    // 匹配常见的跳转 URL 模式
    const patterns = [
      /https?:\/\/www\.douyin\.com\/(?:video|note)\/\d+/,
      /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/,
      /location\.replace\s*\(\s*["']([^"']+)["']\s*\)/,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        return match[1] || match[0];
      }
    }
  } catch {
    // 忽略 HTML 解析错误
  }

  throw new Error("短链接重定向失败，链接可能已失效");
}

/**
 * 从 URL 中提取视频/图集 ID
 * 支持多种抖音链接格式
 */
function extractAwemeId(url) {
  // 标准视频链接: /video/7449123456789012345
  let match = url.match(/\/video\/(\d+)/);
  if (match) return match[1];

  // 图集链接: /note/7449123456789012345
  match = url.match(/\/note\/(\d+)/);
  if (match) return match[1];

  // 分享弹窗链接: modal_id=7449123456789012345
  match = url.match(/modal_id=(\d+)/);
  if (match) return match[1];

  // 直接参数: aweme_id=7449123456789012345
  match = url.match(/aweme_id=(\d+)/);
  if (match) return match[1];

  // item_id 参数
  match = url.match(/item_id=(\d+)/);
  if (match) return match[1];

  // 兜底：匹配 17-20 位纯数字（抖音 ID 特征）
  match = url.match(/(\d{17,20})/);
  if (match) return match[1];

  return null;
}

/**
 * 调用抖音 API 获取视频/图集详情
 * 优先使用分享 API（iesdouyin），失败后回退到主站 API
 */
async function fetchItemDetail(awemeId) {
  // 主方案：抖音分享/嵌入 API（对海外访问更友好）
  try {
    return await fetchFromIesdouyin(awemeId);
  } catch (err) {
    console.log("iesdouyin API 失败，尝试备用方案:", err.message);
  }

  // 备用方案：抖音主站 API
  return await fetchFromDouyin(awemeId);
}

/**
 * 方案一：通过 iesdouyin.com 分享 API 获取
 */
async function fetchFromIesdouyin(awemeId) {
  const apiUrl = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}`;

  const resp = await fetch(apiUrl, {
    headers: {
      ...HEADERS,
      Referer: "https://www.douyin.com/",
    },
  });

  if (!resp.ok) {
    throw new Error(`API 返回状态码 ${resp.status}`);
  }

  const data = await resp.json();

  if (data.status_code !== 0) {
    throw new Error(`API 返回错误 (status_code: ${data.status_code})`);
  }

  if (!data.item_list || data.item_list.length === 0) {
    throw new Error("该内容不存在，可能已被删除或设为私密");
  }

  return data.item_list[0];
}

/**
 * 方案二：通过 douyin.com 主站 API 获取
 */
async function fetchFromDouyin(awemeId) {
  const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=6383`;

  const resp = await fetch(apiUrl, {
    headers: {
      ...HEADERS,
      Referer: "https://www.douyin.com/",
    },
  });

  if (!resp.ok) {
    throw new Error(`无法访问抖音服务器 (HTTP ${resp.status})，请稍后重试`);
  }

  const data = await resp.json();

  if (data.status_code !== 0 && data.status_code !== undefined) {
    throw new Error(`抖音返回错误 (status_code: ${data.status_code})`);
  }

  if (!data.aweme_detail) {
    throw new Error("该内容不存在，可能已被删除或设为私密");
  }

  return data.aweme_detail;
}

/**
 * 格式化 API 返回数据为前端可用的结构
 */
function formatResponse(item) {
  // 判断类型：有 images 数组 = 图集，否则 = 视频
  const hasImages =
    item.images && Array.isArray(item.images) && item.images.length > 0;
  const type = hasImages ? "image" : "video";

  // === 公共字段 ===
  const result = {
    type,
    aweme_id: item.aweme_id,
    desc: item.desc || "",
    create_time: item.create_time,
    author: {
      nickname: item.author?.nickname || "未知用户",
      unique_id: item.author?.unique_id || item.author?.short_id || "",
      avatar: pickFirstUrl(item.author?.avatar_thumb?.url_list) ||
        pickFirstUrl(item.author?.avatar_medium?.url_list) || "",
    },
    statistics: {
      likes: item.statistics?.digg_count || 0,
      comments: item.statistics?.comment_count || 0,
      shares: item.statistics?.share_count || 0,
      plays: item.statistics?.play_count || 0,
    },
  };

  // === 图集处理 ===
  if (type === "image") {
    result.images = item.images.map((img) => ({
      // origin_url 是原图，url_list 是不同尺寸
      url: pickFirstUrl(img.origin_url?.url_list) || pickFirstUrl(img.url_list) || "",
      thumbnail: pickFirstUrl(img.url_list, 1) || pickFirstUrl(img.url_list) || "",
      width: img.width || 0,
      height: img.height || 0,
    }));
    result.image_count = result.images.length;
    // 图集的封面通常是第一张图
    result.cover = result.images[0]?.thumbnail || result.images[0]?.url || "";
  }

  // === 视频处理 ===
  if (type === "video") {
    const video = item.video;
    if (!video) {
      throw new Error("未找到视频数据，该内容可能不是视频");
    }

    // 获取最优视频地址（优先无水印）
    result.video = {
      url: getBestVideoUrl(video),
      duration: video.duration || 0, // 毫秒
      width: video.width || 0,
      height: video.height || 0,
      cover: pickFirstUrl(video.cover?.url_list) ||
        pickFirstUrl(video.origin_cover?.url_list) ||
        pickFirstUrl(video.dynamic_cover?.url_list) || "",
    };

    // 多清晰度选项（如果可用）
    if (video.bit_rate && Array.isArray(video.bit_rate) && video.bit_rate.length > 0) {
      result.video.qualities = video.bit_rate
        .map((br) => ({
          label: br.gear_name || formatBitrate(br.bit_rate),
          bit_rate: br.bit_rate,
          url: pickFirstUrl(br.play_addr?.url_list) || "",
        }))
        .filter((q) => q.url); // 去掉没有 URL 的
    }
  }

  // === 音乐信息 ===
  if (item.music) {
    result.music = {
      title: item.music.title || "",
      author: item.music.author || "",
      cover: pickFirstUrl(item.music.cover_thumb?.url_list) ||
        pickFirstUrl(item.music.cover_medium?.url_list) || "",
    };
  }

  return result;
}

/**
 * 从 URL 列表中取第一个（或指定索引的）
 */
function pickFirstUrl(urlList, index = 0) {
  if (!urlList || !Array.isArray(urlList) || urlList.length === 0) return "";
  return urlList[index] || urlList[0] || "";
}

/**
 * 获取最优无水印视频地址
 * 优先级：download_addr > play_addr_h264 > play_addr > 手工拼接
 */
function getBestVideoUrl(video) {
  // 1. download_addr — 下载地址，通常无水印
  if (video.download_addr?.url_list?.length > 0) {
    return cleanWatermarkParam(video.download_addr.url_list[0]);
  }

  // 2. play_addr_h264 — H.264 编码播放地址
  if (video.play_addr_h264?.url_list?.length > 0) {
    return cleanWatermarkParam(video.play_addr_h264.url_list[0]);
  }

  // 3. play_addr — 标准播放地址（有水印，尝试清洗）
  if (video.play_addr?.url_list?.length > 0) {
    return cleanWatermarkParam(video.play_addr.url_list[0]);
  }

  // 4. 兜底：从 play_addr 的 uri 提取 video_id 手工拼接
  if (video.play_addr?.uri) {
    const vidMatch = video.play_addr.uri.match(/[a-z0-9]{15,}/i);
    if (vidMatch) {
      return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${vidMatch[0]}&ratio=1080p&line=0`;
    }
  }

  throw new Error("无法获取视频地址，该视频可能已被删除");
}

/**
 * 清洗视频 URL 中的水印参数
 */
function cleanWatermarkParam(url) {
  // 将 watermark=1 改为 watermark=0
  return url.replace(/watermark=1/gi, "watermark=0");
}

/**
 * 格式化码率为可读标签
 */
function formatBitrate(bitRate) {
  if (!bitRate) return "未知";
  const mbps = (bitRate / 1000000).toFixed(1);
  return `${mbps} Mbps`;
}
