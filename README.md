# x-api-mcp

基于 X 官方 API v2 的**本地 stdio MCP 服务器**，核心是多账号发帖：发帖、回复、串推（thread）、删帖、图片/GIF/视频上传（含分块上传），外加 `users/me` 和近 7 天搜索。

X 官方的 remote MCP 不支持发帖，这个项目补的就是这块。

## 为什么是 stdio

服务器跑在用户自己的电脑上，由 MCP 客户端（Claude Desktop、Claude Code、Cursor 等）以子进程启动。OAuth 授权、access/refresh token 都只存在本机 `~/.x-api-mcp/tokens.json`（权限 0600），不经过任何第三方服务器。

## 准备一个 X App

1. 在 [console.x.com](https://console.x.com) 创建 App，并充值按量计费额度。
2. 打开 **User authentication settings**：
   - App permissions：**Read and write**
   - Type of App：**Native App**（公共客户端，不需要 Client Secret，推荐）；选 Web App 也可以，再额外配置 `X_CLIENT_SECRET`
   - Callback URI：`http://127.0.0.1:8765/callback`（必须与 `X_REDIRECT_URI` 完全一致）
3. 复制 OAuth 2.0 **Client ID**。

> 计费说明：所有调用都计在 Client ID 所属 App 的额度上。如果你把自己的 Client ID 分发给别人用，他们发帖花的是你的钱；让每个用户用自己的 App 最稳妥。

## 安装与配置

```bash
npm install && npm run build      # 发布到 npm 后可直接 npx -y x-api-mcp
```

Claude Desktop / Cursor（`claude_desktop_config.json` / `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "x": {
      "command": "node",
      "args": ["/绝对路径/x-api-mcp/dist/index.js"],
      "env": { "X_CLIENT_ID": "你的 Client ID" }
    }
  }
}
```

Claude Code：

```bash
claude mcp add x -e X_CLIENT_ID=你的ClientID -- node /绝对路径/x-api-mcp/dist/index.js
```

## 授权账号

两种方式，结果相同，可以重复执行来添加多个账号：

- **在对话里**：让 AI 调用 `add_account`，打开返回的链接并在浏览器里点授权，本地监听器自动收下回调并保存 token。
- **命令行**：`X_CLIENT_ID=... node dist/index.js login`，会自动打开浏览器并等待回调。

第一个授权的账号成为默认账号；其他账号在工具调用里用 `account: "用户名"` 指定，或用 `set_default_account` 切换。access token 过期前自动用 refresh token 续期（X 的 refresh token 是轮换的，多个进程同时续期时有文件锁保护）。

## 工具

| 工具 | 作用 | 是否计费 |
| --- | --- | --- |
| `list_accounts` | 列出本机已授权账号 | 免费 |
| `add_account` / `auth_status` | 发起 OAuth 2.0 PKCE 授权 / 查看授权结果 | 授权完成时调用一次 `users/me` |
| `complete_authorization` | 回调监听不可用时，粘贴回调 URL 手动完成（授权码约 30 秒过期） | 同上 |
| `set_default_account` / `remove_account` | 切换默认账号 / 删除账号并吊销 token | 免费 |
| `get_me` | `GET /2/users/me` | 是 |
| `create_post` | 发帖、回复（`reply_to_post_id`）、引用、投票、附媒体（可直接传本地文件 `media_files`） | 是 |
| `create_thread` | 按顺序发串推，遇错即停并返回已发出的部分 | 每条都计费 |
| `delete_post` | 删帖 | 是 |
| `upload_media` | ≤5 MB 图片一次上传；GIF、视频和大文件走 initialize/append/finalize 分块上传并等待处理完成；可设 alt text | 见官方价格 |
| `get_media_status` | 查询视频处理状态 | 是 |
| `search_recent_posts` | 近 7 天搜索 | 按返回条数计费 |

价格以 [官方价格页](https://docs.x.com/x-api/getting-started/pricing) 和控制台为准。注意：带 URL 的帖子单价明显更高；`quote_post_id` 目前官方文档标注仅 Enterprise 可用。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `X_CLIENT_ID` | — | 必填 |
| `X_CLIENT_SECRET` | — | 仅 Web App（机密客户端）需要 |
| `X_REDIRECT_URI` | `http://127.0.0.1:8765/callback` | 需与 App 设置一致 |
| `X_SCOPES` | `tweet.read tweet.write users.read media.write offline.access` | |
| `X_API_MCP_HOME` | `~/.x-api-mcp` | token 存放目录 |
| `X_DEFAULT_ACCOUNT` | — | 没有在本地设置默认账号时使用 |

## 命令行

```
x-api-mcp                    以 stdio 方式运行 MCP 服务器
x-api-mcp login              浏览器授权新账号
x-api-mcp accounts           列出账号（* 为默认）
x-api-mcp default <用户名>    设置默认账号
x-api-mcp logout <用户名>     删除账号并吊销 token
x-api-mcp post [--account a] <文本>   快速发一条测试帖
```

## 开发

```bash
npm test   # 编译后对本地模拟的 X API 跑端到端测试（OAuth、续期轮换、并发锁、串推、分块上传、stdio 协议）
```

代码结构：`src/oauth.ts`（PKCE 与 token 端点）、`src/auth.ts`（授权流程与本地回调）、`src/store.ts`（token 文件与锁）、`src/client.ts`（带自动续期的 API 客户端）、`src/posts.ts`、`src/media.ts`、`src/server.ts`（MCP 工具注册）、`src/index.ts`（入口与 CLI）。

## 参考

- [OAuth 2.0 PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)、[发帖](https://docs.x.com/x-api/posts/create-post)、[分块上传](https://docs.x.com/x-api/media/quickstart/media-upload-chunked)
- [xdevplatform/xurl](https://github.com/xdevplatform/xurl)、[xdevplatform/xmcp](https://github.com/xdevplatform/xmcp)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
