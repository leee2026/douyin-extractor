# 📱 社交媒体内容提取工具

粘贴分享链接，一键下载无水印内容。支持**抖音**和**小红书**。

## 功能

| 平台 | 内容类型 | 水印处理 |
|------|---------|---------|
| 🎵 抖音 | 视频、图集（图文） | 自动去水印 |
| 📕 小红书 | 视频笔记、图文笔记 | 无需去水印 |

## 部署方式

### 方式A：Vercel（海外节点，免费）

1. 上传代码到 GitHub 仓库
2. 在 [vercel.com](https://vercel.com) 导入仓库 → Deploy
3. 获得 `https://xxx.vercel.app` 网址

> ⚠️ 海外节点，国内访问可能偏慢。建议绑定自己域名改善访问。

### 方式B：腾讯云 CloudBase（国内节点）

需要：微信/QQ 实名认证 + 腾讯云账号

1. 打开 [cloud.tencent.com](https://cloud.tencent.com)，搜索"云开发 CloudBase"
2. 创建环境 → 开通静态网站托管和云函数
3. 修改 `cloudbaserc.json` 中的 `envId` 为你的环境ID
4. 安装 CLI：
   ```bash
   npm i -g @cloudbase/cli
   tcb login
   ```
5. 部署：
   ```bash
   tcb fn deploy parse        # 部署云函数
   tcb hosting deploy ./ -e <envId>  # 部署静态网站
   ```
6. 获得国内加速域名

## 项目结构

```
├── index.html            # 前端页面
├── api/parse.js          # Vercel 云函数（海外）
├── functions/parse/      # CloudBase 云函数（国内）
│   ├── index.js          # 云函数入口
│   └── package.json
├── vercel.json           # Vercel 配置
├── cloudbaserc.json      # CloudBase 配置
└── package.json
```

## 本地测试

```bash
# Vercel
npx vercel dev

# 或直接用静态服务器
npx serve .
```

## 注意事项

- 仅支持**公开**内容，私密内容无法提取
- 仅供个人学习研究使用
- 如接口变动导致解析失败，需更新代码
