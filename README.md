# tg-double-chat-bot

Telegram 双向私聊机器人，部署在 Cloudflare Workers 上。

## 功能

- 用户给机器人发消息 → 自动转发给管理员
- 管理员回复转发的消息 → 自动发回给对应用户
- 真人验证（数学题）防止机器人滥用
- 敏感词拦截（内置 30+ 关键词，支持自定义添加）
- 垃圾信息存储（被拦截的消息存入 KV，管理员可随时查看）
- 封禁/解封用户
- 菜单按钮支持（输入 `/` 显示命令菜单）

---

## 部署步骤

### 1. 准备工作

| 项目 | 说明 |
|------|------|
| Cloudflare 账号 | 免费注册 [dash.cloudflare.com](https://dash.cloudflare.com) |
| Bot Token | 在 Telegram 找 [@BotFather](https://t.me/BotFather) 发 `/newbot` 创建，拿到 Token |
| 管理员 User ID | 找 [@userinfobot](https://t.me/userinfobot) 发 `/start`，拿到纯数字 ID |
| Node.js | 本地安装 [Node.js](https://nodejs.org)（用于 Wrangler CLI） |

### 2. 克隆项目

```bash
git clone https://github.com/caspian-vex/tg-double-chat-bot.git
cd tg-double-chat-bot
npm install -g wrangler
```

### 3. 配置 Wrangler

编辑 `wrangler.toml`，填入你的 Worker 信息和环境变量：

```toml
name = "tg-double-chat-bot"
main = "worker.js"
compatibility_date = "2026-06-05"

[observability]
enabled = false
head_sampling_rate = 1

[observability.logs]
enabled = true

# 非敏感变量放这里
[vars]
ADMIN_ID = "你的数字ID"
WORKER_URL = "https://你的worker名.你的子域名.workers.dev"
```

**⚠️ Bot Token 是敏感信息**，用命令行设置：

```bash
wrangler secret put BOT_TOKEN
# 输入你的 Token，例如 7234567890:AAH...
```

### 4. 创建 KV 命名空间并绑定

在 Cloudflare Dashboard 上：

1. Workers & Pages → KV → **创建命名空间** → 取名 `TG_USER_DB`
2. 回到 `worker.js` 所在的 Worker → 设置 → 变量 → **KV 命名空间绑定**
   - 变量名：`USER_KV`
   - KV 命名空间：选择 `TG_USER_DB`

> `wrangler.toml` 里也可以加一行：
> ```toml
> [[kv_namespaces]]
> binding = "USER_KV"
> id = "你的KV命名空间ID"
> ```
> KV 命名空间 ID 在 Cloudflare Dashboard → KV → 你的命名空间 页面可以看到。

### 5. 部署

```bash
wrangler deploy
```

部署成功后终端会显示 Worker URL，记下来。

### 6. 设置 Webhook

浏览器访问：

```
https://你的域名/setup
```

看到 `{"ok": true}` 表示 Webhook 注册成功。

### 7. 设置菜单按钮

```
https://你的域名/setcommands
```

此后用户输入 `/` 即可看到菜单。

### 8. 测试

在 Telegram 给机器人发 `/start`，应该收到回复。

---

## 管理员命令一览

| 命令 | 说明 |
|------|------|
| `/stats` | 查看统计（用户数、垃圾箱计数） |
| `/spamlist` | 📦 查看最近拦截的垃圾信息 |
| `/clearspam` | 🗑️ 清空垃圾箱 |
| `/block <ID>` | 🔨 封禁指定用户 |
| `/unblock <ID>` | ✅ 解封指定用户 |
| `/blocklist` | 📋 查看封禁列表 |
| `/addkw <词>` | 添加敏感词 |
| `/delkw <词>` | 删除敏感词 |
| `/kwlist` | 查看敏感词列表 |
| `/kwmode <block\|warn>` | 切换拦截/警告模式 |

### 两种使用方式

- **回复某条转发的用户消息** → 自动把回复内容转发给对应用户
- **直接发文字** → 模拟用户消息转发给自己（单号测试）

---

## 实用路由

| 路径 | 用途 |
|------|------|
| `/` 或 `/health` | 健康检查 |
| `/setup` | 设置 Webhook |
| `/delete-webhook` | 删除 Webhook |
| `/webhook-info` | 查看 Webhook 状态 |
| `/setcommands` | 设置菜单按钮 |

---

## 目录结构

```
tg-double-chat-bot/
├── worker.js         # 机器人主代码
├── wrangler.toml     # Wrangler 配置
└── README.md         # 本文件
```

---

## 常见问题

**Q: 我只有一个 Telegram 号怎么测试？**
A: 管理员直接发文字会被当成用户消息转发给自己，可以完整走通双向流程。

**Q: Worker 部署后没反应？**
A: 先访问 `/webhook-info` 检查 Webhook 状态，再查看 Cloudflare Worker 日志。

**Q: 环境变量部署后被清空了？**
A: 用 `wrangler secret put` 设置的变量不会被清。普通变量写在 `wrangler.toml` 的 `[vars]` 中。

**Q: KV 里面没有数据？**
A: KV 只在敏感词触发、封禁/解封、验证通过等操作时才写入。管理员自身操作不会触发写入。
