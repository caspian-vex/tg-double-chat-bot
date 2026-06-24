# tg-double-chat-bot
# 部署教程大部分由AI编写，可能会存在不合理的地方，需自行判断(懒)
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

### 2. 克隆项目

将此 GitHub 项目 Fork 到你的 GitHub 账号下

### 3. 在 Cloudflare 创建 Worker（通过 GitHub）

1. 进入 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages**
2. 点击 **创建** → 选择 **Continue with GitHub**
3. 授权 Cloudflare 访问 GitHub，选择你 Fork 的 `tg-double-chat-bot` 仓库
4. 点击 **部署**，Worker 会自动部署到 Cloudflare
5. 部署完成后**概述**下面会显示你的WORKER_URL

### 4. 配置环境变量

共需要三个环境变量：

> 全部在 Cloudflare Dashboard → Worker → 设置 → 变量和密钥 中添加。

| 变量名 | 类型 | 说明 | 示例 |
|--------|------|------|------|
| `BOT_TOKEN` |  密钥 | Telegram Bot Token | `7234567890:AAHxxxxxxxxxxxxxxxx` |
| `ADMIN_ID` |  文本 | 管理员 ID | `123456789` |
| `WORKER_URL` |  文本 | Worker 访问地址 | `https://tg-double-chat-bot.xxx.workers.dev` |




### 5. 创建 KV 命名空间并绑定(黑名单和垃圾处理，可选)

在 Cloudflare Dashboard 上：

1. Workers & Pages → KV → **创建命名空间** → 取名 `TG_USER_DB`(建议不要改其他名字，你可能记不住)
2. 回到 `worker.js` 所在的 Worker →  **绑定** →添加绑定 →选择KV命名空间
   - 变量名称：`USER_KV`
   - KV 命名空间：选择 `TG_USER_DB`

### 7. 设置 Webhook

浏览器访问：

```
https://你的域名/setup
```

看到 `{"ok": true}` 表示 Webhook 注册成功。

### 8. 设置菜单按钮

```
https://你的域名/setcommands
```

此后用户输入 `/` 即可看到菜单。

### 9. 测试

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

**Q: Worker 部署后没反应？**
A: 先访问 `/webhook-info` 检查 Webhook 状态，再查看 Cloudflare Worker 日志。

**Q: 重新部署后环境变量被清空了？**
A: WORKER_URL和ADMIN_ID会随之清空，不想的话可以设置成密钥类型。

**Q: KV 里面没有数据？**
A: KV 只在敏感词触发、封禁/解封、验证通过等操作时才写入。管理员自身操作不会触发写入。
