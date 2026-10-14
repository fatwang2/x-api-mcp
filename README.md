# x-api-mcp

基于 X 官方 API v2 的**本地 stdio MCP 服务器**，核心是多账号发帖：发帖、回复、串推（thread）、删帖、图片/GIF/视频上传（含分块上传），同时覆盖点赞、转发、书签、关注、时间线、搜索、私信、列表和趋势。

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

工具按“动作”合并，而不是一个端点一个工具，共 25 个，方便 agent 选择。所有工具都有可选的 `account` 参数（不填用默认账号）；需要指定用户的地方传 `@用户名`、`用户名` 或数字 ID。

| 分组 | 工具 | 说明 |
| --- | --- | --- |
| 账号 | `list_accounts` `add_account` `auth_status` `complete_authorization` `set_default_account` `remove_account` `get_me` | 多账号授权与管理；只有 `get_me` 会调用 API |
| 发帖 | `create_post` | 发帖、回复、引用、投票、附媒体（可直接传本地文件） |
| | `create_thread` | 按顺序发串推，遇错即停并返回已发出的部分 |
| | `delete_post` | 删帖 |
| | `post_action` | like / unlike / repost / unrepost / bookmark / unbookmark / hide_reply / unhide_reply |
| 媒体 | `upload_media` `get_media_status` | ≤5 MB 图片一次上传；GIF、视频、大文件分块上传并等处理完成；可设 alt text |
| 读取 | `search` | `type=posts` 近 7 天搜帖，`type=users` 搜用户 |
| | `get_posts` | 按 ID 批量查帖子 |
| | `get_timeline` | home（首页时间线）/ posts / mentions / liked / bookmarks |
| | `get_post_engagement` | 点赞用户 / 转发用户 / 引用帖 |
| 用户 | `get_users` | 按用户名或 ID 批量查资料 |
| | `get_user_relations` | followers / following，以及自己的 muting / blocking 列表 |
| | `user_action` | follow / unfollow / mute / unmute / block / unblock |
| 私信 | `send_dm` `get_dm_events` | 发私信（给用户或已有会话，可带媒体）/ 读私信 |
| 列表 | `list_action` `get_lists` | 创建、修改、删除列表，增删成员 / 查看自己的列表、列表信息、成员、帖子 |
| 趋势 | `get_trends` | 个性化趋势 |

几乎所有调用都按量计费，价格以 [官方价格页](https://docs.x.com/x-api/getting-started/pricing) 和控制台为准。带 URL 的帖子单价明显更高；官方文档标注 `quote_post_id` 和 block 仅 Enterprise 可用。

授权时默认申请所有用到的 scope。如果某个账号授权时少了某个权限（比如用旧版授权的账号），调用会在请求 X 之前直接提示“重新 add_account”。

暂未覆盖：Spaces、书签文件夹、私信删除、流式接口、广告与合规接口。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `X_CLIENT_ID` | — | 必填 |
| `X_CLIENT_SECRET` | — | 仅 Web App（机密客户端）需要 |
| `X_REDIRECT_URI` | `http://127.0.0.1:8765/callback` | 需与 App 设置一致 |
| `X_SCOPES` | 全部用到的读写 scope（见 `src/config.ts`） | 想收窄权限时设置 |
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

代码结构：`src/oauth.ts`（PKCE 与 token 端点）、`src/auth.ts`（授权流程与本地回调）、`src/store.ts`（token 文件与锁）、`src/client.ts`（带自动续期的 API 客户端）、`src/posts.ts`（发帖）、`src/social.ts`（互动、关系、时间线、私信、列表）、`src/shape.ts`（返回结果精简）、`src/media.ts`、`src/server.ts`（MCP 工具注册）、`src/index.ts`（入口与 CLI）。

## 参考

- [OAuth 2.0 PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)、[发帖](https://docs.x.com/x-api/posts/create-post)、[分块上传](https://docs.x.com/x-api/media/quickstart/media-upload-chunked)
- [xdevplatform/xurl](https://github.com/xdevplatform/xurl)、[xdevplatform/xmcp](https://github.com/xdevplatform/xmcp)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
