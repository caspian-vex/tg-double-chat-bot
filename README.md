# tg-double-chat-bot
# 部署教程大部分由AI编写，可能会存在不合理的地方，需自行判断(懒)
Telegram 双向私聊机器人，部署在 Cloudflare Workers 上。

## 功能

- 用户给机器人发消息 → 自动归档到私有超级群中该用户的专属话题
- 管理员在话题里发消息 → 自动发回给对应用户
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
| 私有超级群 | 创建私有群，开启“话题”，将机器人加入并授予管理员的“管理话题”和“删除消息”权限 |

### 2. 克隆项目

将此 GitHub 项目 Fork 到你的 GitHub 账号下

### 3. 在 Cloudflare 创建 Worker（通过 GitHub）

1. 进入 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages**
2. 点击 **创建** → 选择 **Continue with GitHub**
3. 授权 Cloudflare 访问 GitHub，选择你 Fork 的 `tg-double-chat-bot` 仓库
4. 点击 **部署**，Worker 会自动部署到 Cloudflare
5. 部署完成后**概述**下面会显示你的WORKER_URL

### 4. 配置环境变量

话题模式需要四个环境变量和一个 KV 绑定：

> 全部在 Cloudflare Dashboard → Worker → 设置 → 变量和密钥 中添加。

| 变量名 | 类型 | 说明 | 示例 |
|--------|------|------|------|
| `BOT_TOKEN` |  密钥 | Telegram Bot Token | `7234567890:AAHxxxxxxxxxxxxxxxx` |
| `ADMIN_ID` |  文本 | 管理员 ID | `123456789` |
| `ADMIN_GROUP_ID` | 文本 | 开启话题的私有超级群 ID，通常以 `-100` 开头 | `-1001234567890` |
| `WORKER_URL` |  文本 | Worker 访问地址 | `https://tg-double-chat-bot.xxx.workers.dev` |
| `VERIFY_QUESTIONS` | 文本，可选 | 自定义验证题库，JSON 数组 | 见下方示例 |

首次部署时可以先不填 `ADMIN_GROUP_ID`；完成第 7 步后再填写。

### 自定义验证问题

在 Worker 的“设置 → 变量和密钥”中添加 `VERIFY_QUESTIONS`，值为 JSON 数组，每项包含字符串类型的 `question` 和 `answer`：

```json
[
  {"question":"你从哪里知道这个机器人？","answer":"官网"},
  {"question":"请填写约定的联络暗号","answer":"蓝鲸"}
]
```

机器人会随机选一道题。用户的回答会去掉首尾空格后与答案逐字比较，大小写和中间空格不会自动转换。可以按需增删题目；不设置该变量时继续使用原来的 12 道数学题。格式错误或题库为空时，机器人不会发放新题，管理员会收到配置错误提示。已发出的题目仍按原答案验证，已经通过验证的用户也不会重新验证。

验证过程中再次发送 `/start` 或 `/help` 只会重发当前题目，不会直接通过验证，也不计入错误次数。




### 5. 创建 KV 命名空间并绑定（话题模式必需）

在 Cloudflare Dashboard 上：

1. Workers & Pages → KV → **创建命名空间** → 取名 `TG_USER_DB`。
2. 将该命名空间的 ID 填入 `wrangler.toml` 中 `[[kv_namespaces]]` 的 `id`。本仓库当前 ID 只适用于原 Cloudflare 账号；Fork 后必须替换成自己的 ID。
3. 回到 Worker → **设置 → 绑定**，确认生产环境存在以下 KV 绑定：
   - 变量名称：`USER_KV`
   - KV 命名空间：选择 `TG_USER_DB`

KV 保存用户 ID 与话题 ID 的对应关系。未绑定 `USER_KV` 时，机器人不会创建话题或转发用户消息。Git 部署以 `wrangler.toml` 为准，控制台提示“Update your Wrangler configuration”时应把绑定同步到该文件。

### 6. 设置 Webhook

浏览器访问：

```
https://你的域名/setup
```

看到 `{"ok": true}` 表示 Webhook 注册成功。

### 7. 获取超级群 ID

在群中以管理员账号发送 `/chatid`，机器人会回复群 ID、群类型和话题状态。只有显示 `supergroup` 且“话题: 已开启”才可用于此模式。将这时返回的群 ID 填入 `ADMIN_GROUP_ID`；不要沿用升级前普通群的 ID，也不要手工在旧 ID 前拼 `-100`。机器人必须是群管理员，否则可能收不到话题中的普通消息。

管理员还可以私聊机器人发送 `/config`，查看当前运行环境是否读到 `USER_KV`，以及 `ADMIN_GROUP_ID` 指向的群类型和话题状态。

### 8. 设置菜单按钮

```
https://你的域名/setcommands
```

每次更新命令列表后，可在浏览器打开上面的完整地址，或由管理员**私聊机器人发送** `/setcommands`。普通用户输入 `/` 会看到 `/start`、`/help`；管理员私聊机器人时会看到全部管理命令。

### 9. 测试

在 Telegram 给机器人发 `/start`，按提示完成验证后发一条消息。超级群应出现只显示 `@username` 的话题；没有用户名时使用显示名称，标题不包含用户 ID。消息应进入该话题。管理员在话题中直接发消息，用户私聊应收到回复。已创建的话题会在对应用户下次发消息时更新标题。

---

## 管理员命令一览

| 命令 | 说明 |
|------|------|
| `/stats` | 查看统计（用户数、垃圾箱计数） |
| `/config` | 检查 KV 绑定、管理员群类型和话题状态 |
| `/setcommands` | 更新 Telegram 命令菜单（管理员私聊） |
| `/spamlist` | 📦 查看最近拦截的垃圾信息 |
| `/clearspam` | 🗑️ 清空垃圾箱 |
| `/block <ID>` | 🔨 封禁指定用户 |
| `/unblock <ID>` | ✅ 解封指定用户 |
| `/blocklist` | 📋 查看封禁列表 |
| `/deleteuser <ID>` | 删除该用户话题及话题消息，清除其 KV 数据 |
| `/addkw <词>` | 添加敏感词 |
| `/delkw <词>` | 删除敏感词 |
| `/kwlist` | 查看敏感词列表 |
| `/kwmode <block\|warn>` | 切换拦截/警告模式 |

### 对话方式

- 用户只需私聊机器人；文字和常见媒体消息会复制进专属话题。
- 只有 `ADMIN_ID` 指定的账号在配置的超级群话题中发出的消息会转发给用户。管理员私聊机器人仍可使用管理命令。
- 普通群话题、其他群成员的消息不会转发给用户。
- 管理员也可在用户的话题中直接发送 `/deleteuser`，无需填写 ID。该命令不会转发给用户；机器人会私聊管理员报告结果。删除会永久移除该话题中的消息，并清除用户资料、验证/封禁状态、话题映射及垃圾箱中该用户的记录。KV 同步后，用户再次联系会重新验证。

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
├── worker.test.mjs   # 本地测试
├── wrangler.toml     # Wrangler 配置
└── README.md         # 本文件
```

---

## 常见问题

**Q: Worker 部署后没反应？**
A: 先访问 `/webhook-info` 检查 Webhook 状态，再查看 Cloudflare Worker 日志。

**Q: 重新部署后环境变量被清空了？**
A: WORKER_URL和ADMIN_ID会随之清空，不想的话可以设置成密钥类型。

**Q: KV 里面没有话题映射？**
A: 用户完成验证并发送第一条正常消息后才会创建话题，KV 中会出现 `user_topic:` 和 `topic_user:` 键。
