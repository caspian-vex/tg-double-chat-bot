/**
 * Telegram 双向私聊机器人 - Cloudflare Workers 部署
 *
 * 功能：
 * 1. 用户给机器人发消息 → 转发给管理员
 * 2. 管理员回复转发的消息 → 自动发回给对应用户
 * 3. 支持文字、图片、视频、文件、语音、贴纸等多种消息类型
 *
 * 环境变量 (在 Cloudflare Dashboard 中设置):
 *   BOT_TOKEN   - Telegram Bot Token (从 @BotFather 获取)
 *   ADMIN_ID    - 管理员的 Telegram User ID (数字格式)
 *   WORKER_URL  - Worker 部署后的完整 URL (如 https://xxx.workers.dev)
 */

// 消息ID → { userId, username } 映射表（用于精确匹配回复目标）
const messageUserMap = new Map();

// ====== 安全防护 ======
const blockedUsers = new Set();        // 被封禁的用户ID
const verifiedUsers = new Set();       // 已通过真人验证的用户ID
const pendingVerification = new Map(); // userId → { answer, attempts }
const bannedKeywords = new Set([    // 敏感关键词列表
  '加群',
  '进群',
  '推广',
  '广告',
  '返利',
  '博彩',
  '代投',
  '套利',
  'USDT',
  'BTC',
  'ETH',
  '币圈',
  '空投',
  '交易所',
  '稳赚',
  '客服',
  '开户链接',
  '刷单',
  '兼职',
  '日赚',
  '高回报',
  '零风险',
  '投资',
  '理财',
  '赚钱',
  '引流',
  '群发',
  '频道',
  '中间商',
  '交流群',
  '介绍',
]);
let keywordAction = 'block';        // 'block'=拦截, 'warn'=警告+转发
let dataLoaded = false;             // 是否已从KV加载数据

// ====== KV 持久化辅助函数 ======

async function loadFromKV(env) {
  if (!env.USER_KV || dataLoaded) return;
  try {
    const [blockedRaw, verifiedRaw, pendingRaw, keywordsRaw, kwActionRaw] = await Promise.all([
      env.USER_KV.get('blocked_users'),
      env.USER_KV.get('verified_users'),
      env.USER_KV.get('pending_verification'),
      env.USER_KV.get('banned_keywords'),
      env.USER_KV.get('keyword_action'),
    ]);

    if (blockedRaw) {
      const arr = JSON.parse(blockedRaw);
      arr.forEach(id => blockedUsers.add(id));
    }
    if (verifiedRaw) {
      const arr = JSON.parse(verifiedRaw);
      arr.forEach(id => verifiedUsers.add(id));
    }
    if (pendingRaw) {
      const obj = JSON.parse(pendingRaw);
      Object.entries(obj).forEach(([k, v]) => pendingVerification.set(parseInt(k), v));
    }
    if (keywordsRaw) {
      const arr = JSON.parse(keywordsRaw);
      arr.forEach(kw => bannedKeywords.add(kw));
    }
    if (kwActionRaw) {
      keywordAction = kwActionRaw;
    }
    dataLoaded = true;
    console.log('✅ 从KV加载数据完成');
  } catch (e) {
    console.error('从KV加载数据失败:', e);
    dataLoaded = true; // 即使失败也标记以免重复尝试
  }
}

async function saveBlockedToKV(env) {
  if (!env.USER_KV) return;
  await env.USER_KV.put('blocked_users', JSON.stringify(Array.from(blockedUsers)));
}

async function saveVerifiedToKV(env) {
  if (!env.USER_KV) return;
  await env.USER_KV.put('verified_users', JSON.stringify(Array.from(verifiedUsers)));
}

async function savePendingToKV(env) {
  if (!env.USER_KV) return;
  const obj = {};
  pendingVerification.forEach((v, k) => { obj[k] = v; });
  await env.USER_KV.put('pending_verification', JSON.stringify(obj));
}

async function saveKeywordsToKV(env) {
  if (!env.USER_KV) return;
  await env.USER_KV.put('banned_keywords', JSON.stringify(Array.from(bannedKeywords)));
}

async function saveKwActionToKV(env) {
  if (!env.USER_KV) return;
  await env.USER_KV.put('keyword_action', keywordAction);
}

// ====== 垃圾信息存储 ======
const SPAM_KEY = 'spam_log';
const SPAM_MAX = 200; // 最多存200条

async function saveSpamToKV(env, msg, matchedKeyword) {
  if (!env.USER_KV) return;
  try {
    const raw = await env.USER_KV.get(SPAM_KEY);
    let list = raw ? JSON.parse(raw) : [];
    list.unshift({
      time: Date.now(),
      userId: msg.from.id,
      name: msg.from.first_name || '' + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
      username: msg.from.username || '',
      text: msg.text || '',
      keyword: matchedKeyword,
    });
    if (list.length > SPAM_MAX) list = list.slice(0, SPAM_MAX);
    await env.USER_KV.put(SPAM_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('保存垃圾信息失败:', e);
  }
}

async function getSpamCount(env) {
  if (!env.USER_KV) return -1;
  try {
    const raw = await env.USER_KV.get(SPAM_KEY);
    if (!raw) return 0;
    const list = JSON.parse(raw);
    return list.length;
  } catch { return 0; }
}

async function clearSpamFromKV(env) {
  if (!env.USER_KV) return;
  await env.USER_KV.delete(SPAM_KEY);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ========== 状态/健康检查 ==========
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('🤖 Telegram 双向私聊机器人运行中', { status: 200 });
    }

    // ========== 设置 Webhook ==========
    if (url.pathname === '/setup') {
      return await setupWebhook(env);
    }

    // ========== 删除 Webhook ==========
    if (url.pathname === '/delete-webhook') {
      return await deleteWebhook(env);
    }

    // ========== 查看 Webhook 状态 ==========
    if (url.pathname === '/webhook-info') {
      return await getWebhookInfo(env);
    }

    // ========== 接收 Telegram 更新 ==========
    if (url.pathname.startsWith('/webhook/') && request.method === 'POST') {
      try {
        // 验证 token（兼容冒号被 URL 编码为 %3A 的情况）
        let tokenInPath = url.pathname.slice('/webhook/'.length);
        // 尝试 URL 解码（如果 token 包含编码字符）
        const decodedToken = decodeURIComponent(tokenInPath);
        if (decodedToken !== tokenInPath) tokenInPath = decodedToken;

        if (tokenInPath !== env.BOT_TOKEN) {
          console.warn(
            `Webhook token 不匹配! 收到="${tokenInPath.substring(0, 15)}..." ` +
            `期望="${env.BOT_TOKEN?.substring(0, 15)}..."`
          );
          return new Response('Forbidden', { status: 403 });
        }
        const update = await request.json();
        // 先加载KV数据，再处理消息（确保先后顺序）
        ctx.waitUntil((async () => {
          await loadFromKV(env);
          await handleUpdate(update, env, ctx);
        })());
      } catch (e) {
        console.error('处理更新出错:', e);
      }
      return new Response('OK');
    }

    return new Response('404 Not Found', { status: 404 });
  },
};

/**
 * 设置 Telegram Webhook
 */
async function setupWebhook(env) {
  if (!env.WORKER_URL) {
    return new Response('❌ 请先设置环境变量 WORKER_URL', { status: 400 });
  }
  const webhookUrl = `${env.WORKER_URL.replace(/\/+$/, '')}/webhook/${env.BOT_TOKEN}`;
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message'],
        drop_pending_updates: true,
      }),
    }
  );
  const result = await res.json();
  return new Response(JSON.stringify(result, null, 2), {
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 删除 Webhook
 */
async function deleteWebhook(env) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`,
    { method: 'POST' }
  );
  const result = await res.json();
  return new Response(JSON.stringify(result, null, 2), {
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 查看 Webhook 状态
 */
async function getWebhookInfo(env) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`
  );
  const result = await res.json();
  return new Response(JSON.stringify(result, null, 2), {
    headers: { 'content-type': 'application/json' },
  });
}

// ===================== 消息处理核心逻辑 =====================

async function handleUpdate(update, env, ctx) {
  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const chatType = msg.chat.type;

  try {
    // 只处理私聊消息
    if (chatType !== 'private') return;

    // 检查环境变量
    if (!env.BOT_TOKEN) {
      console.error('BOT_TOKEN 未设置');
      return;
    }
    if (!env.ADMIN_ID) {
      console.error('ADMIN_ID 未设置');
      return;
    }

    // 判断发送者是否为管理员
    const isAdmin = userId == env.ADMIN_ID;

    if (isAdmin) {
      await handleAdminMessage(msg, env, ctx);
    } else {
      // ====== 安全验证 ======

      // 1. 封禁检查
      if (blockedUsers.has(userId)) {
        return;
      }

      // 2. 真人验证
      if (!verifiedUsers.has(userId)) {
        await handleHumanVerification(msg, env, ctx);
        return;
      }

      // ====== 记录用户信息到 KV（如果配置了 USER_KV 存储）======
      if (env.USER_KV) {
        await recordUser(env, userId, {
          id: userId,
          first_name: msg.from.first_name,
          last_name: msg.from.last_name,
          username: msg.from.username,
          language_code: msg.from.language_code,
          last_active: Date.now(),
        });
      }
      await handleUserMessage(msg, env);
    }
  } catch (e) {
    console.error('handleUpdate 出错:', e);
    // 尝试通知管理员出错
    try {
      if (env.ADMIN_ID) {
        await callTelegramApi(env, 'sendMessage', {
          chat_id: env.ADMIN_ID,
          text: `❌ 机器人处理消息时出错:\n${e.message}\n\n请检查 Worker 日志。`,
        });
      }
    } catch {}
  }
}

// ===================== 处理用户消息 =====================

async function handleUserMessage(msg, env) {
  const from = msg.from;
  const userId = from.id;
  const userName = escapeHtml(from.first_name || '');
  const lastName = escapeHtml(from.last_name || '');
  const fullName = [userName, lastName].filter(Boolean).join(' ');
  const username = from.username ? `@${escapeHtml(from.username)}` : '';
  const langCode = from.language_code || '';

  // 构建转发头信息
  const header =
    `📩 用户消息\n` +
    `🆔 #${userId}\n` +
    `👤 ${fullName}\n` +
    `${username ? `🔗 ${username}\n` : ''}` +
    `${langCode ? `🌐 ${langCode}\n` : ''}` +
    `📅 ${new Date().toLocaleString('zh-CN')}\n` +
    `──────────────────`;

  // 只处理文字消息
  try {
    if (msg.text) {
      // 处理命令
      if (msg.text.startsWith('/')) {
        await handleUserCommand(msg, env);
        return;
      }

      // 关键词拦截
      if (bannedKeywords.size > 0) {
        const matchedKeyword = checkBannedKeywords(msg.text);
        if (matchedKeyword) {
          if (keywordAction === 'block') {
            // 存到垃圾箱再拦截
            await saveSpamToKV(env, msg, matchedKeyword);
            await sendMessage(env, userId, '⚠️ 消息包含敏感内容，已被拦截。');
            return;
          } else {
            // warn 模式：转发并标记
            const text = `${header}\n\n⚠️ 敏感词触发: ${escapeHtml(matchedKeyword)}\n──────────────────\n${escapeHtml(msg.text)}`;
            await sendReplyMarkup(env, env.ADMIN_ID, text, userId, username);
            await sendMessage(env, userId, '✅ 消息已发送给管理员，请等待回复~');
            return;
          }
        }
      }

      const text = `${header}\n\n${escapeHtml(msg.text)}`;
      // 单独 try-catch，即使转发失败也不影响确认消息
      try {
        await sendReplyMarkup(env, env.ADMIN_ID, text, userId, username);
      } catch (e) {
        console.error('转发消息失败:', e);
      }
    } else {
      // 非文字消息暂不支持
      await sendMessage(env, userId, '⚠️ 目前仅支持文字消息，请发送文字。');
    }

    // 通知用户消息已发送
    await sendMessage(env, userId, '✅ 消息已发送给管理员，请等待回复~');
  } catch (e) {
    console.error('转发用户消息失败:', e);
  }
}

/**
 * 处理用户发送的命令
 */
async function handleUserCommand(msg, env) {
  const cmd = msg.text.split(' ')[0];
  switch (cmd) {
    case '/start':
      await sendMessage(
        env,
        msg.chat.id,
        `👋 你好！我是双向私聊机器人。\n\n` +
        `📝 直接发送消息给我，我会转发给管理员。\n` +
        `⏳ 管理员回复后，我会第一时间转发给你。\n\n` +
        `📝 目前仅支持文字消息。`
      );
      break;
    case '/help':
      await sendMessage(
        env,
        msg.chat.id,
        `💡 使用说明\n\n` +
        `直接发送文字消息即可，管理员会收到并回复你。\n\n` +
        `📝 目前仅支持文字消息。`
      );
      break;
    default:
      await sendMessage(env, msg.chat.id, `❓ 未知命令，发送 /help 查看帮助`);
  }
}

// ===================== 处理管理员消息 =====================

async function handleAdminMessage(msg, env, ctx) {
  // 处理管理员命令
  if (msg.text && msg.text.startsWith('/')) {
    await handleAdminCommand(msg, env, ctx);
    return;
  }

  // 如果有回复消息 → 回复用户
  if (msg.reply_to_message) {
    const targetUserId = extractUserId(msg.reply_to_message);
    if (!targetUserId) {
      await sendMessage(
        env,
        env.ADMIN_ID,
        '❌ 无法识别目标用户，请确保回复的是系统转发的消息。'
      );
      return;
    }
    const targetUsername = extractUsername(msg.reply_to_message);

    // 转发管理员的回复给用户
    try {
      const replyHeader = `📨 管理员回复:\n──────────────────`;

      if (msg.text) {
        const text = `${replyHeader}\n\n${escapeHtml(msg.text)}`;
        await sendMessage(env, targetUserId, text);
      } else if (msg.photo) {
        const caption = msg.caption
          ? `${replyHeader}\n\n${escapeHtml(msg.caption)}`
          : replyHeader;
        await sendPhoto(env, targetUserId, msg.photo[msg.photo.length - 1].file_id, caption);
      } else if (msg.video) {
        const caption = msg.caption
          ? `${replyHeader}\n\n${escapeHtml(msg.caption)}`
          : replyHeader;
        await sendVideo(env, targetUserId, msg.video.file_id, caption);
      } else if (msg.document) {
        const caption = msg.caption
          ? `${replyHeader}\n\n${escapeHtml(msg.caption)}`
          : replyHeader;
        await sendDocument(env, targetUserId, msg.document.file_id, caption);
      } else if (msg.audio) {
        const caption = msg.caption
          ? `${replyHeader}\n\n${escapeHtml(msg.caption)}`
          : replyHeader;
        await sendAudio(env, targetUserId, msg.audio.file_id, caption);
      } else if (msg.voice) {
        await sendVoice(env, targetUserId, msg.voice.file_id);
        await sendMessage(env, targetUserId, replyHeader);
      } else if (msg.sticker) {
        await sendSticker(env, targetUserId, msg.sticker.file_id);
        await sendMessage(env, targetUserId, replyHeader);
      } else if (msg.animation) {
        const caption = msg.caption
          ? `${replyHeader}\n\n${escapeHtml(msg.caption)}`
          : replyHeader;
        await sendAnimation(env, targetUserId, msg.animation.file_id, caption);
      } else if (msg.video_note) {
        await sendVideoNote(env, targetUserId, msg.video_note.file_id);
        await sendMessage(env, targetUserId, replyHeader);
      } else {
        await sendMessage(env, env.ADMIN_ID, '❌ 不支持回复此类型的消息');
        return;
      }

      await sendMessage(env, env.ADMIN_ID, `✅ 回复已发送给用户 #${targetUserId} ${targetUsername}`);
    } catch (e) {
      console.error('回复用户失败:', e);
      await sendMessage(env, env.ADMIN_ID, `❌ 回复发送失败: ${e.message}`);
    }
    return;
  }

  // ===== 没有回复消息 = 视为用户发送的消息 =====
  // 把管理员的消息当成普通用户消息处理，模拟用户→管理员的转发
  const fakeMsg = {
    ...msg,
    from: {
      id: env.ADMIN_ID,
      first_name: msg.from.first_name || '我',
      last_name: msg.from.last_name,
      username: msg.from.username,
      language_code: msg.from.language_code,
      is_bot: false,
    },
    chat: { id: env.ADMIN_ID, type: 'private' },
    reply_to_message: undefined,
  };
  await handleUserMessage(fakeMsg, env);
}

/**
 * 从消息中提取用户 ID
 * 优先通过消息ID查映射表，再回退到正则解析文本
 */
function extractUserId(message) {
  // 优先通过消息ID查找
  if (message.message_id) {
    const info = messageUserMap.get(message.message_id);
    if (info) return info.userId;
  }
  // 回退：在 text 中查找 #数字
  if (message.text) {
    const match = message.text.match(/#(\d+)/);
    if (match) return parseInt(match[1]);
  }
  // 回退：在 caption 中查找 #数字
  if (message.caption) {
    const match = message.caption.match(/#(\d+)/);
    if (match) return parseInt(match[1]);
  }
  return null;
}

/**
 * 从消息中提取用户名
 */
function extractUsername(message) {
  if (message.message_id) {
    const info = messageUserMap.get(message.message_id);
    if (info?.username) return info.username;
  }
  // 回退：在 text 中查找 @用户名
  if (message.text) {
    const match = message.text.match(/🔗\s*@(\S+)/);
    if (match) return `@${match[1]}`;
  }
  if (message.caption) {
    const match = message.caption.match(/🔗\s*@(\S+)/);
    if (match) return `@${match[1]}`;
  }
  return '';
}

// ===================== 真人验证 =====================

const VERIFY_QUESTIONS = [
  { q: '1 加 1 = ?', a: '2' },
  { q: '5 加 3 = ?', a: '8' },
  { q: '10 减 4 = ?', a: '6' },
  { q: '7 加 8 = ?', a: '15' },
  { q: '20 除 4 = ?', a: '5' },
  { q: '3 乘 3 = ?', a: '9' },
  { q: '12 加 15 = ?', a: '27' },
  { q: '100 减 25 = ?', a: '75' },
  { q: '6 乘 7 = ?', a: '42' },
  { q: '9 加 6 = ?', a: '15' },
  { q: '30 除 5 = ?', a: '6' },
  { q: '4 乘 8 = ?', a: '32' },
];

async function handleHumanVerification(msg, env, ctx) {
  const userId = msg.from.id;

  // 如果用户正处在验证流程中，检查回答
  if (pendingVerification.has(userId)) {
    const verify = pendingVerification.get(userId);

    // 检查是不是 /start 或 /help
    if (msg.text && (msg.text === '/start' || msg.text === '/help')) {
      // 直接通过验证（是真人发命令的行为）
      verifiedUsers.add(userId);
      pendingVerification.delete(userId);
      await saveVerifiedToKV(env);
      await savePendingToKV(env);
      await sendMessage(env, userId, '✅ 验证通过！现在你可以发送消息了。');
      // 顺便处理命令
      if (msg.text === '/start') {
        await sendMessage(
          env,
          userId,
          `👋 你好！我是双向私聊机器人。\n\n` +
          `📝 直接发送消息给我，我会转发给管理员。\n` +
          `⏳ 管理员回复后，我会第一时间转发给你。\n\n` +
          `📝 目前仅支持文字消息。`
        );
      } else {
        await sendMessage(
          env,
          userId,
          `💡 使用说明\n\n` +
          `直接发送文字消息即可，管理员会收到并回复你。\n\n` +
          `📝 目前仅支持文字消息。`
        );
      }
      return;
    }

    // 检查回答是否正确
    if (msg.text && msg.text.trim() === verify.answer) {
      // 验证通过
      verifiedUsers.add(userId);
      pendingVerification.delete(userId);
            await saveVerifiedToKV(env);
      await savePendingToKV(env);
      await sendMessage(env, userId, '✅ 验证通过！现在你可以发送消息了。');
      return;
    }

    // 回答错误
    verify.attempts++;
    if (verify.attempts >= 3) {
      // 3次错误，封禁
      blockedUsers.add(userId);
      pendingVerification.delete(userId);
      await saveBlockedToKV(env);
      await savePendingToKV(env);
      await sendMessage(env, userId, '❌ 验证失败次数过多，你已被禁止使用此机器人。');
      return;
    }

    await sendMessage(env, userId, `❌ 答案不对，再试试！(${verify.attempts}/3)\n\n🧮 问题是: ${verify.question}`);
    return;
  }

  // 首次验证：生成随机题目
  const question = VERIFY_QUESTIONS[Math.floor(Math.random() * VERIFY_QUESTIONS.length)];
  pendingVerification.set(userId, {
    answer: question.a,
    attempts: 0,
    question: question.q,
  });

    await savePendingToKV(env);

  await sendMessage(
    env,
    userId,
    `🧮 请回答验证问题以证明你是真人:\n\n` +
    `${question.q}\n\n` +
    `你有 3 次机会。回答正确后即可使用机器人。`
  );
}

/**
 * 处理管理员命令
 */
async function handleAdminCommand(msg, env, ctx) {
  const cmd = msg.text.split(' ')[0];
  const args = msg.text.split(' ').slice(1);

  switch (cmd) {
    case '/start':
      await sendMessage(
        env,
        env.ADMIN_ID,
        `👋 欢迎使用双向私聊机器人！\n\n` +
        `📌 使用方式：\n` +
        `• 用户发来的消息会自动转发到这里\n` +
        `• 回复消息即可回复对应用户\n` +
        `• 支持文字/图片/视频/文件等\n\n` +
        `📋 可用命令:\n` +
        `/stats - 查看统计\n` +
        `/spamlist - 📦 查看拦截的垃圾信息\n` +
        `/clearspam - 🗑️ 清空垃圾信息\n` +
        `/block <ID> - 封禁用户\n` +
        `/unblock <ID> - 解封用户\n` +
        `/blocklist - 查看封禁列表\n` +
        `/help - 帮助`
      );
      break;

    case '/help':
      await sendMessage(
        env,
        env.ADMIN_ID,
        `📋 管理员命令:\n\n` +
        `/stats - 查看机器人统计信息\n` +
        `/spamlist - 📦 查看拦截的垃圾信息（含用户信息和内容）\n` +
        `/clearspam - 🗑️ 清空所有已拦截记录\n` +
        `/block <ID> - 🔨 封禁指定用户\n` +
        `/unblock <ID> - ✅ 解封指定用户\n` +
        `/blocklist - 📋 查看封禁列表\n` +
        `/addkw <词> - 添加敏感词\n` +
        `/delkw <词> - 删除敏感词\n` +
        `/kwlist - 查看敏感词列表\n` +
        `/kwmode <block|warn> - 拦截/警告模式\n` +
        `/help - 显示此帮助\n\n` +
        `💡 回复任意用户消息即可回复该用户。`
      );
      break;

    case '/stats':
      // 简单统计 - 从 KV 获取数据（如果有配置 KV）
      const userCount = env.USER_KV
        ? await getUserCount(env)
        : '未配置 KV 存储';
        const spamCount = env.USER_KV ? await getSpamCount(env) : -1;
      await sendMessage(
        env,
        env.ADMIN_ID,
        `📊 机器人统计\n\n` +
        `👤 联系过的用户: ${userCount}\n` +
        `📦 拦截垃圾信息: ${spamCount === -1 ? '未配置 KV 存储' : spamCount}\n` +
        `🤖 机器人状态: 运行中`
      );
      break;

    case '/spamlist': {
      if (!env.USER_KV) {
        await sendMessage(env, env.ADMIN_ID, '❌ 需要配置 KV 命名空间 (USER_KV)');
        return;
      }
      try {
        const raw = await env.USER_KV.get(SPAM_KEY);
        if (!raw) {
          await sendMessage(env, env.ADMIN_ID, '📦 垃圾箱为空，暂无拦截记录。');
          return;
        }
        const list = JSON.parse(raw);
        const showCount = Math.min(list.length, 5);
        let msg = `📦 垃圾信息记录 (共${list.length}条，显示最近${showCount}条):\n\n`;
        for (let i = 0; i < showCount; i++) {
          const item = list[i];
          const date = new Date(item.time).toLocaleString('zh-CN');
          const name = escapeHtml(item.name);
          const uname = item.username ? `@${escapeHtml(item.username)}` : '';
          msg += `#${i+1} 🆔 ${item.userId} ${name} ${uname}\n`;
          msg += `🔑 触发词: ${escapeHtml(item.keyword)}\n`;
          msg += `💬 ${escapeHtml(item.text)}\n`;
          msg += `🕐 ${date}\n\n`;
        }
        if (list.length > 5) {
          msg += `… 还有 ${list.length - 5} 条，使用 /clearspam 清空\n`;
        }
        await sendMessage(env, env.ADMIN_ID, msg);
      } catch (e) {
        await sendMessage(env, env.ADMIN_ID, `❌ 读取垃圾箱失败: ${e.message}`);
      }
      break;
    }

    case '/clearspam': {
      if (!env.USER_KV) {
        await sendMessage(env, env.ADMIN_ID, '❌ 需要配置 KV 命名空间 (USER_KV)');
        return;
      }
      await clearSpamFromKV(env);
      await sendMessage(env, env.ADMIN_ID, '🗑️ 垃圾箱已清空。');
      break;
    }

    case '/block': {
      const targetId = parseInt(args[0]);
      if (!targetId || isNaN(targetId)) {
        await sendMessage(env, env.ADMIN_ID, '❌ 用法: /block <用户ID>');
        return;
      }
      if (targetId == env.ADMIN_ID) {
        await sendMessage(env, env.ADMIN_ID, '❌ 不能封禁管理员自己');
        return;
      }
            blockedUsers.add(targetId);
      await saveBlockedToKV(env);
      await sendMessage(env, env.ADMIN_ID, `🔨 已封禁用户 #${targetId}`);
      break;
    }

    case '/unblock': {
      const targetId = parseInt(args[0]);
      if (!targetId || isNaN(targetId)) {
        await sendMessage(env, env.ADMIN_ID, '❌ 用法: /unblock <用户ID>');
        return;
      }
            blockedUsers.delete(targetId);
      await saveBlockedToKV(env);
      await sendMessage(env, env.ADMIN_ID, `✅ 已解封用户 #${targetId}`);
      break;
    }

    case '/blocklist': {
      if (blockedUsers.size === 0) {
        await sendMessage(env, env.ADMIN_ID, '📋 封禁列表为空，目前没有封禁任何用户。');
        return;
      }
      const list = Array.from(blockedUsers).join('\n• #');
      await sendMessage(env, env.ADMIN_ID, `📋 被封禁用户:\n• #${list}`);
      break;
    }

    case '/addkw': {
      const kw = args.join(' ');
      if (!kw) {
        await sendMessage(env, env.ADMIN_ID, '❌ 用法: /addkw <关键词>');
        return;
      }
            bannedKeywords.add(kw);
      await saveKeywordsToKV(env);
      await sendMessage(env, env.ADMIN_ID, `✅ 已添加敏感词: ${escapeHtml(kw)}`);
      break;
    }

    case '/delkw': {
      const kw = args.join(' ');
      if (!kw) {
        await sendMessage(env, env.ADMIN_ID, '❌ 用法: /delkw <关键词>');
        return;
      }
      if (!bannedKeywords.has(kw)) {
        await sendMessage(env, env.ADMIN_ID, `❌ 敏感词不存在: ${escapeHtml(kw)}`);
        return;
      }
            bannedKeywords.delete(kw);
      await saveKeywordsToKV(env);
      await sendMessage(env, env.ADMIN_ID, `✅ 已删除敏感词: ${escapeHtml(kw)}`);
      break;
    }

    case '/kwlist': {
      if (bannedKeywords.size === 0) {
        await sendMessage(env, env.ADMIN_ID, `📋 敏感词列表为空，当前模式: ${keywordAction === 'block' ? '🔨 拦截' : '⚠️ 警告'}`);
        return;
      }
      const list = Array.from(bannedKeywords).join('\n• ');
      await sendMessage(env, env.ADMIN_ID, `📋 敏感词列表 (${keywordAction === 'block' ? '🔨 拦截' : '⚠️ 警告'}):\n• ${list}`);
      break;
    }

    case '/kwmode': {
      const mode = args[0];
            if (mode === 'block') {
        keywordAction = 'block';
        await saveKwActionToKV(env);
        await sendMessage(env, env.ADMIN_ID, '🔨 关键词模式已切换为: 拦截（命中直接拦截）');
      } else if (mode === 'warn') {
        keywordAction = 'warn';
        await saveKwActionToKV(env);
        await sendMessage(env, env.ADMIN_ID, '⚠️ 关键词模式已切换为: 警告（命中仍转发，附标记）');
      } else {
        await sendMessage(env, env.ADMIN_ID, '❌ 用法: /kwmode <block|warn>');
      }
      break;
    }

    default:
      await sendMessage(env, env.ADMIN_ID, `❓ 未知命令，输入 /help 查看帮助`);
  }
}

/**
 * 检查消息是否包含敏感词
 */
function checkBannedKeywords(text) {
  for (const kw of bannedKeywords) {
    if (text.includes(kw)) {
      return kw;
    }
  }
  return null;
}

/**
 * 获取用户数量（需要 KV 存储）
 */
async function getUserCount(env) {
  try {
    const allUsers = await env.USER_KV.list();
    return allUsers.keys.length;
  } catch {
    return '未知';
  }
}

/**
 * 记录用户到 KV 存储（可选）
 */
async function recordUser(env, userId, userInfo) {
  if (env.USER_KV) {
    try {
      await env.USER_KV.put(String(userId), JSON.stringify(userInfo));
    } catch (e) {
      console.error('记录用户失败:', e);
    }
  }
}

/**
 * HTML 转义 - 防止用户消息中的 < > & 破坏 Telegram HTML 解析
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ===================== Telegram API 封装 =====================

const API_BASE = 'https://api.telegram.org';

async function callTelegramApi(env, method, payload) {
  const url = `${API_BASE}/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await res.json();
  if (!result.ok) {
    throw new Error(`Telegram API 错误: ${result.description}`);
  }
  return result;
}

/**
 * 发送纯文字消息
 */
async function sendMessage(env, chatId, text, extra = {}) {
  return callTelegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    ...extra,
  });
}

/**
 * 发送文字消息并附带强制回复标记（方便管理员知道在回复谁）
 */
async function sendReplyMarkup(env, chatId, text, userId, username) {
  const res = await callTelegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: {
      force_reply: true,
      input_field_placeholder: `回复用户 #${userId}...`,
    },
  });
  // 记录消息ID → 用户信息 映射
  if (res?.result?.message_id) {
    messageUserMap.set(res.result.message_id, { userId, username: username || '' });
  }
  return res;
}

/**
 * 发送图片
 */
async function sendPhoto(env, chatId, fileId, caption) {
  return callTelegramApi(env, 'sendPhoto', {
    chat_id: chatId,
    photo: fileId,
    caption,
  });
}

async function sendPhotoWithReply(env, chatId, fileId, caption, userId, username) {
  const res = await callTelegramApi(env, 'sendPhoto', {
    chat_id: chatId,
    photo: fileId,
    caption,
    reply_markup: {
      force_reply: true,
      input_field_placeholder: `回复用户 #${userId}...`,
    },
  });
  if (res?.result?.message_id) {
    messageUserMap.set(res.result.message_id, { userId, username: username || '' });
  }
  return res;
}

/**
 * 发送视频
 */
async function sendVideo(env, chatId, fileId, caption) {
  return callTelegramApi(env, 'sendVideo', {
    chat_id: chatId,
    video: fileId,
    caption,
  });
}

async function sendVideoWithReply(env, chatId, fileId, caption, userId, username) {
  const res = await callTelegramApi(env, 'sendVideo', {
    chat_id: chatId,
    video: fileId,
    caption,
    reply_markup: {
      force_reply: true,
      input_field_placeholder: `回复用户 #${userId}...`,
    },
  });
  if (res?.result?.message_id) {
    messageUserMap.set(res.result.message_id, { userId, username: username || '' });
  }
  return res;
}

/**
 * 发送文件
 */
async function sendDocument(env, chatId, fileId, caption) {
  return callTelegramApi(env, 'sendDocument', {
    chat_id: chatId,
    document: fileId,
    caption,
  });
}

async function sendDocumentWithReply(env, chatId, fileId, caption, userId, username) {
  const res = await callTelegramApi(env, 'sendDocument', {
    chat_id: chatId,
    document: fileId,
    caption,
    reply_markup: {
      force_reply: true,
      input_field_placeholder: `回复用户 #${userId}...`,
    },
  });
  if (res?.result?.message_id) {
    messageUserMap.set(res.result.message_id, { userId, username: username || '' });
  }
  return res;
}

/**
 * 发送音频
 */
async function sendAudio(env, chatId, fileId, caption) {
  return callTelegramApi(env, 'sendAudio', {
    chat_id: chatId,
    audio: fileId,
    caption,
  });
}

async function sendAudioWithReply(env, chatId, fileId, caption, userId, username) {
  const res = await callTelegramApi(env, 'sendAudio', {
    chat_id: chatId,
    audio: fileId,
    caption,
    reply_markup: {
      force_reply: true,
      input_field_placeholder: `回复用户 #${userId}...`,
    },
  });
  if (res?.result?.message_id) {
    messageUserMap.set(res.result.message_id, { userId, username: username || '' });
  }
  return res;
}

/**
 * 发送语音
 */
async function sendVoice(env, chatId, fileId) {
  return callTelegramApi(env, 'sendVoice', {
    chat_id: chatId,
    voice: fileId,
  });
}

async function sendVoiceWithReply(env, chatId, fileId, caption, userId, username) {
  const res = await callTelegramApi(env, 'sendVoice', {
    chat_id: chatId,
    voice: fileId,
    caption,
    reply_markup: {
      force_reply: true,
      input_field_placeholder: `回复用户 #${userId}...`,
    },
  });
  if (res?.result?.message_id) {
    messageUserMap.set(res.result.message_id, { userId, username: username || '' });
  }
  return res;
}

/**
 * 发送贴纸
 */
async function sendSticker(env, chatId, fileId) {
  return callTelegramApi(env, 'sendSticker', {
    chat_id: chatId,
    sticker: fileId,
  });
}

/**
 * 发送动画 (GIF)
 */
async function sendAnimation(env, chatId, fileId, caption) {
  return callTelegramApi(env, 'sendAnimation', {
    chat_id: chatId,
    animation: fileId,
    caption,
  });
}

async function sendAnimationWithReply(env, chatId, fileId, caption, userId, username) {
  const res = await callTelegramApi(env, 'sendAnimation', {
    chat_id: chatId,
    animation: fileId,
    caption,
    reply_markup: {
      force_reply: true,
      input_field_placeholder: `回复用户 #${userId}...`,
    },
  });
  if (res?.result?.message_id) {
    messageUserMap.set(res.result.message_id, { userId, username: username || '' });
  }
  return res;
}

/**
 * 发送短视频消息
 */
async function sendVideoNote(env, chatId, fileId) {
  return callTelegramApi(env, 'sendVideoNote', {
    chat_id: chatId,
    video_note: fileId,
  });
}

/**
 * 发送位置
 */
async function sendLocation(env, chatId, latitude, longitude) {
  return callTelegramApi(env, 'sendLocation', {
    chat_id: chatId,
    latitude,
    longitude,
  });
}
