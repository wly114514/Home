# AIGirlFriend v1.1

基于 Node.js 的中文 AI 角色陪伴网站，包含二次元界面、角色聊天、图片生成、角色语音和小说创作。这是当前 Node.js 版本的源码发布副本，不包含任何线上账号、数据库、API 密钥、音色 ID 或用户生成内容。

## 功能

- 148 个预设角色：原神 73 位、崩坏：星穹铁道 75 位，支持分组折叠菜单、搜索和自定义角色
- 流式文字回复、独立角色设定、按角色保存的聊天历史及浏览器本地缓存
- JPEG、PNG、WebP 图片附件：选择、拖拽、粘贴、上传进度、取消与重试，每条最多 3 张、每张不超过 8 MiB
- 阿里云视觉识别与角色聊天衔接，支持纯图发送、鉴权历史缩略图和原图查看
- 图片生成任务、画质和比例设置、进度展示、历史图片查看
- CosyVoice 角色语音：只使用该角色自己的已配置音色，支持历史播放及免费重播
- 小说大纲、章节正文生成，用户钱包、积分记录和管理页面
- 图片验证码或可选 Cloudflare Turnstile 验证
- 响应式桌面和手机布局

当前聊天文字回复为 5 点；成功生成角色语音另收 5 点，语音失败不扣语音费用，历史音频重播不重复收费。积分是本应用的站内记账规则，与模型服务商费用分开。

图片识别不另加站内积分；文字回复仍为 5 点，成功语音另收 5 点。发送开始立即清空输入区，失败时恢复原文字和附件，切换角色不会带入旧角色未发送的图片。

支付模块有订单和签名回调基础逻辑，创建订单尚未返回真实收银台地址；正式收款需自行完整接入支付 SDK 和支付平台验签。模拟充值默认关闭。

## 环境要求

- Node.js 24 LTS（启动脚本检查主版本至少为 24）
- npm
- 支持配置的文字/图片模型 API；角色语音可选使用阿里云 DashScope CosyVoice

SQLite 使用 Node.js 内置 `node:sqlite`，不需要额外数据库服务。依赖只有 `bcryptjs` 和 `sharp`，首次安装需要 npm 网络连接及对应平台的 sharp 二进制支持。

## 安装与启动

进入本目录，安装锁定依赖：

```bash
npm ci
```

复制配置模板：

```bash
# Linux / macOS
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

编辑 `.env`，至少填写 `AI_API_KEY`、`AI_BASE_URL`、`AI_COMPANION_MODEL`、`AI_NOVEL_MODEL`，并将 `JWT_SECRET`、`ADMIN_PASSWORD`、`PAY_CALLBACK_SECRET` 的占位值替换为各自独立的随机值。生产模式会拒绝占位 JWT 密钥或管理员密码。可在本机生成随机字符串：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

启动：

```bash
npm start
```

也可使用项目脚本：

```powershell
.\start.ps1
```

```bash
bash start.sh
```

默认访问地址为 `http://127.0.0.1:8000/web/index.html`。请通过 HTTP 打开页面，前端接口和静态资源由同一个 Node.js 服务提供。

| 页面 | 路径 |
| --- | --- |
| 首页、注册和登录 | `/web/index.html` |
| 角色聊天 | `/web/companion-chat.html` |
| 小说创作 | `/web/novel.html` |
| 管理页面 | `/web/admin-wechat.html` |

首次运行自动建立空的 SQLite 数据库；本发布包没有预置用户或管理员登录令牌。管理员密码来自部署者自己的配置。

## 模型配置

文字接口支持 OpenAI 兼容 Chat Completions 或 Responses。根据自己的服务商设置 `AI_TEXT_API_MODE=chat` 或 `responses`；模型名、令牌字段、是否支持 `temperature` 也需与实际接口一致。`.env.example` 中的服务地址和模型名只是占位值。

生图接口可以与文字接口分开配置，使用 `AI_IMAGE_KEY`、`AI_IMAGE_ENDPOINT`、`AI_IMAGE_MODEL` 和 `AI_IMAGE_API_MODE`。没有配置时，相关功能不会自动获得可用模型。生成图片和音频由服务器保存在运行目录，不能提交到 Git。

## 可选：图片上传与阿里云识图

在自己的 `.env` 中配置 `DASHSCOPE_VISION_API_KEY`、`AI_VISION_BASE_URL` 和 `AI_VISION_MODEL`。识图使用独立配置，不会借用文字或语音密钥。模板中的密钥和模型名称是占位值，请填入自己的可用配置。

每条消息最多 3 张 JPEG、PNG 或 WebP，每张上传文件最多 8 MiB。服务器校验并规范化为最大边长 2048 的 JPEG 原图及 320 像素 WebP 缩略图，移除原始图片元数据。用户图片保存在 `.private/companion-attachments`，读取必须经过当前用户的 Bearer 鉴权；该目录不能放入公开静态资源或 Git。

缩略图按需读取，点开时才加载原图。识图失败不消费附件或扣除本次文字积分，可保留原附件重试。历史仅保留必要附件元数据和识图观察，不将图片 base64 写入浏览器历史缓存。

反向代理需要允许上传端点接收至少 8 MiB 请求体（例如 Nginx 对 `POST /api/companion/attachments` 设置 `client_max_body_size 9m`），并在图片 CSP 中允许 `img-src 'self' data: blob:`，以显示鉴权取得的 Blob 图片。请按自己的部署环境补充其他已有 CSP 来源。

如需将视觉密钥与主配置分开，可自行创建被 Git 忽略的 `.vision.env`；服务器默认会读取其限定的视觉配置，也支持进程环境变量 `VISION_ENV_FILE` 显式指定文件。此发布包仅提供 `.env.example`，不会包含实际 `.vision.env`。

## 可选：CosyVoice 角色语音

1. 在自己的 DashScope 账户准备有权使用的角色专属音色
2. 在 `.env` 配置 `MEDIA_TTS_PROVIDER=cosyvoice`、`DASHSCOPE_API_KEY` 和与音色匹配的 `COSYVOICE_MODEL`
3. 复制 `companion_voice_catalog.example.json` 为 `companion_voice_catalog.json`
4. 在 `voices` 对象中以 `companion_presets.json` 的稳定 `key` 为键填入自己的映射，例如：

```json
{
  "version": 1,
  "model": "cosyvoice-v3.5-flash",
  "voices": {
    "preset_03": {
      "name": "流萤",
      "model": "cosyvoice-v3.5-flash",
      "voice_id": "your-own-enrolled-voice-id",
      "status": "ready"
    }
  }
}
```

示例音色目录的 `voices` 默认为空，因此语音按钮在未配置前会显示尚无音色。未配置的角色不会借用其他角色的音色。音色 ID、API 密钥和实际目录文件应始终保留在部署环境中。

服务默认只读取本项目 `.env` 和进程环境变量。只有部署者显式设置进程环境变量 `COSYVOICE_ENV_FILE` 时，才会额外读取所指定文件中的 TTS 配置；公开版本不包含作者个人电脑的外部配置路径。无需使用该选项即可在本项目 `.env` 完成配置。

## 部署配置

默认绑定 `127.0.0.1:8000`，可用自己的反向代理提供 HTTPS；按部署需求设置 `HOST`、`PORT` 和 `CORS_ORIGINS`。跨域来源列表请填写自己的域名，公开版本只预置本地来源。

Turnstile 是可选项。使用时同时填写自己的站点公钥和服务端密钥，并在 Cloudflare 配置对应域名；未配置时使用应用自带图片验证码。正式部署保持 `LOCAL_DEV=0`、`ALLOW_MOCK_PAYMENT=false`，使用独立强密钥，并定期备份数据库和生成媒体。

本发布包已将作者个人收款二维码和备案号替换为占位内容，请按实际站点情况自行配置。这里不包含作者服务器的部署目录、域名、服务单元或任何生产凭据。

## 检查

```bash
npm run check
npm test
```

测试使用本地模拟服务和临时数据库，不需要真实模型 API、线上账号或真实音色。公开包的源文件语法已检查；构建发布包时没有调用收费模型、生产聊天或支付。

## 目录

```text
backend-node/              Node.js API、模型适配和测试
assets/                    页面样式、交互脚本和公开角色图片
companion_presets.json      角色目录、人设及公开来源链接
companion_voice_catalog.example.json  空音色目录示例
.env.example               无真实凭据的配置模板
index.html                 首页
companion-chat.html         聊天页
novel.html                  小说页
admin-wechat.html           管理页
```

此副本仅包含现行 Node.js 实现，旧 Python/Java 后端、历史部署工具、运行数据库、完整语音参考库、用户媒体、缓存和日志均不包含。资源来源与权利说明见 [ASSET-NOTICE.md](ASSET-NOTICE.md)。
