# 🎵 抖音无水印提取工具

输入抖音分享链接，一键下载无水印视频和图集。适配手机网页端。

## 功能

- ✅ 支持抖音短视频、图集（图文）
- ✅ 自动去除水印
- ✅ 自动显示作者、描述、点赞/评论/分享数据
- ✅ 移动端优化，支持粘贴板自动读取
- ✅ 图集支持逐张下载和批量下载

## 部署（免费，5 分钟搞定）

### 第一步：把代码上传到 GitHub

1. 打开 [github.com](https://github.com) 登录
2. 点击右上角 `+` → `New repository`
3. 仓库名填 `douyin-extractor`，选择 **Public**，不要勾选任何选项，点 `Create repository`
4. 进入创建好的空仓库，点击 `uploading an existing file` 链接
5. 把本目录下的 **所有文件和文件夹** 一起拖进去，点 `Commit changes`

### 第二步：部署到 Vercel

1. 打开 [vercel.com](https://vercel.com)
2. 点 `Sign Up`，选择 `Continue with GitHub`，授权登录
3. 登录后点 `New Project`
4. 在列表里找到刚才上传的 `douyin-extractor` 仓库，点 `Import`
5. 不用改任何设置，直接点 `Deploy`
6. 等 1-2 分钟，部署完成后你会得到一个网址，类似：
   ```
   https://douyin-extractor-xxxxx.vercel.app
   ```

### 第三步：使用

1. 用手机浏览器打开上面那个网址
2. 打开抖音 App → 找到想要的视频/图集 → 点分享 → 复制链接
3. 回到浏览器 → 粘贴链接 → 点「提取」
4. 点击下载按钮保存无水印视频/图片

## 本地测试（可选）

```bash
npm install -g vercel    # 安装 Vercel CLI（只需一次）
vercel dev               # 在项目目录下启动本地服务
```

然后浏览器打开 `http://localhost:3000`

## 注意事项

- 仅支持**公开**视频和图集，私密内容无法提取
- 如遇到"解析失败"，可能是抖音接口变动，请联系更新
- 仅供个人学习研究使用，请勿用于商业用途
- 请遵守抖音用户协议和相关法律法规

## 项目结构

```
douyin-extractor/
├── index.html        # 前端页面（移动端适配）
├── api/
│   └── parse.js      # 后端解析函数（Vercel Serverless）
├── package.json      # 项目配置
├── vercel.json       # Vercel 部署配置
└── README.md         # 本文件
```
