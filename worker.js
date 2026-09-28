/**
 * Telegram 双向私聊机器人 - Cloudflare Workers 部署
 *
 * 功能：
 * 1. 用户给机器人发消息 → 复制到管理员超级群中该用户的话题
 * 2. 管理员在话题中发消息 → 自动发回给对应用户
 * 3. 支持文字、图片、视频、文件、语音、贴纸等多种消息类型
 *
 * 环境变量 (在 Cloudflare Dashboard 中设置):
 *   BOT_TOKEN   - Telegram Bot Token (从 @BotFather 获取)
 *   ADMIN_ID    - 管理员的 Telegram User ID (数字格式)
 *   ADMIN_GROUP_ID - 开启话题的私有超级群 ID（负数）
 *   WORKER_URL  - Worker 部署后的完整 URL (如 https://xxx.workers.dev)
 *   VERIFY_QUESTIONS - 可选，JSON 格式的验证题库
 *   USER_KV     - KV 命名空间绑定，用于持久化话题与用户的对应关系
 */

const topicCreation = new Map(); // 同一 Worker 实例中防止并发创建重复话题
const userTopics = new Map(); // 同一实例内避免 KV 传播延迟导致重复建话题
const topicUsers = new Map(); // 新建话题后立即可供管理员回复使用
const messageUserMap = new Map(); // 兼容旧版私聊中的管理员回复

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
      name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
      username: msg.from.username || '',
      text: msg.text || msg.caption || '',
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

    // ========== 设置菜单按钮 ==========
    if (url.pathname === '/setcommands') {
      return await setBotCommands(env);
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

/**
 * 设置 Bot 菜单按钮
 * type: 'all_private_chats' → 所有用户私聊都显示同样菜单
 */
async function setBotCommands(env) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/setMyCommands`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: '开始使用 / 验证' },
          { command: 'help', description: '查看使用帮助' },
        ],
        scope: { type: 'all_private_chats' },
      }),
    }
  );
  return new Response(JSON.stringify(await res.json(), null, 2), {
    headers: { 'content-type': 'application/json' },
  });
}

// ===================== 消息处理核心逻辑 =====================

async function handleUpdate(update, env, ctx) {
  if (!update.message) return;

  const msg = update.message;
  if (!msg.from) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const chatType = msg.chat.type;

  try {
    // 检查环境变量
    if (!env.BOT_TOKEN) {
      console.error('BOT_TOKEN 未设置');
      return;
    }
    if (!env.ADMIN_ID) {
      console.error('ADMIN_ID 未设置');
      return;
    }

    // 管理员可在超级群发送 /chatid，以便首次配置 ADMIN_GROUP_ID。
    if (chatType === 'supergroup') {
      if (userId == env.ADMIN_ID && msg.text?.split(' ')[0] === '/chatid') {
        await sendMessage(env, chatId, `超级群 ID: ${chatId}`,
          msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {});
      } else if (String(chatId) === String(env.ADMIN_GROUP_ID) && userId == env.ADMIN_ID && !msg.from.is_bot) {
        await handleTopicMessage(msg, env);
      }
      return;
    }
    if (chatType !== 'private') return;

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
  const userId = msg.from.id;
  if (msg.text?.startsWith('/')) {
    await handleUserCommand(msg, env);
    return;
  }

  const matchedKeyword = checkBannedKeywords(msg.text || msg.caption || '');
  if (matchedKeyword && keywordAction === 'block') {
    await saveSpamToKV(env, msg, matchedKeyword);
    await sendMessage(env, userId, '⚠️ 消息包含敏感内容，已被拦截。');
    return;
  }

  if (!env.ADMIN_GROUP_ID || !env.USER_KV) {
    console.error('话题模式需要 ADMIN_GROUP_ID 和 USER_KV');
    await sendMessage(env, userId, '❌ 消息暂时无法发送，请稍后再试。');
    return;
  }

  try {
    const topicId = await getOrCreateTopic(env, msg.from);
    if (matchedKeyword) {
      await sendMessage(env, env.ADMIN_GROUP_ID, `⚠️ 敏感词触发：${matchedKeyword}`, { message_thread_id: topicId });
    }
    await callTelegramApi(env, 'copyMessage', {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: topicId,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    });
    await sendMessage(env, userId, '✅ 消息已发送给管理员，请等待回复~');
  } catch (e) {
    console.error('转发用户消息失败:', e);
    await sendMessage(env, userId, '❌ 消息发送失败，请稍后重试。');
  }
}

async function getOrCreateTopic(env, from) {
  const groupId = String(env.ADMIN_GROUP_ID);
  const userId = String(from.id);
  const userKey = `user_topic:${groupId}:${userId}`;
  if (userTopics.has(userKey)) return userTopics.get(userKey);
  const pending = topicCreation.get(userKey);
  if (pending) return pending;

  const creation = (async () => {
    const existing = await env.USER_KV.get(userKey);
    if (existing) {
      const topicId = Number(existing);
      userTopics.set(userKey, topicId);
      return topicId;
    }

    const displayName = ([from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '用户')
      .replace(/\s+/g, ' ').trim();
    const name = `${displayName.slice(0, 90)} #${userId}`;
    const result = await callTelegramApi(env, 'createForumTopic', {
      chat_id: env.ADMIN_GROUP_ID,
      name,
    });
    const topicId = result.result.message_thread_id;
    if (!topicId) throw new Error('Telegram 未返回话题 ID');
    await env.USER_KV.put(`topic_user:${groupId}:${topicId}`, userId);
    await env.USER_KV.put(userKey, String(topicId));
    userTopics.set(userKey, topicId);
    topicUsers.set(`${groupId}:${topicId}`, userId);
    await sendMessage(env, env.ADMIN_GROUP_ID,
      `👤 ${displayName}\n🆔 ${userId}${from.username ? `\n🔗 @${from.username}` : ''}`,
      { message_thread_id: topicId });
    return topicId;
  })();
  topicCreation.set(userKey, creation);
  try {
    return await creation;
  } finally {
    topicCreation.delete(userKey);
  }
}

async function handleTopicMessage(msg, env) {
  const topicId = msg.message_thread_id;
  if (!topicId || !env.USER_KV) return;
  const groupId = String(env.ADMIN_GROUP_ID);
  const key = `${groupId}:${topicId}`;
  const userId = topicUsers.get(key) || await env.USER_KV.get(`topic_user:${key}`);
  if (!userId) return; // 未关联用户的话题不参与转发
  topicUsers.set(key, userId);

  try {
    await callTelegramApi(env, 'copyMessage', {
      chat_id: userId,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    });
  } catch (e) {
    console.error('话题回复用户失败:', e);
    await sendMessage(env, env.ADMIN_GROUP_ID, `❌ 发送给用户 #${userId} 失败：${e.message}`,
      { message_thread_id: topicId });
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
        `📝 直接发送消息给我，我会放入你的专属话题。\n` +
        `⏳ 管理员回复后，我会第一时间转发给你。\n\n` +
        `📝 支持文字和常见媒体消息。`
      );
      break;
    case '/help':
      await sendMessage(
        env,
        msg.chat.id,
        `💡 使用说明\n\n` +
        `直接发送消息即可，管理员会在你的专属话题收到并回复你。`
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

  // ===== 没有回复消息 → 忽略（管理员直接发的消息不处理）=====
  // 仅回复转发的用户消息才会转发给用户
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

const DEFAULT_VERIFY_QUESTIONS = [
  { question: '1 加 1 = ?', answer: '2' },
  { question: '5 加 3 = ?', answer: '8' },
  { question: '10 减 4 = ?', answer: '6' },
  { question: '7 加 8 = ?', answer: '15' },
  { question: '20 除 4 = ?', answer: '5' },
  { question: '3 乘 3 = ?', answer: '9' },
  { question: '12 加 15 = ?', answer: '27' },
  { question: '100 减 25 = ?', answer: '75' },
  { question: '6 乘 7 = ?', answer: '42' },
  { question: '9 加 6 = ?', answer: '15' },
  { question: '30 除 5 = ?', answer: '6' },
  { question: '4 乘 8 = ?', answer: '32' },
];

function getVerifyQuestions(env) {
  if (!env.VERIFY_QUESTIONS) return DEFAULT_VERIFY_QUESTIONS;

  let questions;
  try {
    questions = JSON.parse(env.VERIFY_QUESTIONS);
  } catch {
    throw new Error('VERIFY_QUESTIONS 必须是有效的 JSON 数组');
  }

  if (!Array.isArray(questions) || questions.length === 0 ||
      questions.some(item => !item || typeof item.question !== 'string' ||
        !item.question.trim() || typeof item.answer !== 'string' || !item.answer.trim())) {
    throw new Error('VERIFY_QUESTIONS 必须是非空数组，每项都需要非空的 question 和 answer 字符串');
  }

  return questions.map(item => ({ question: item.question.trim(), answer: item.answer.trim() }));
}

async function handleHumanVerification(msg, env, ctx) {
  const userId = msg.from.id;

  // 如果用户正处在验证流程中，检查回答
  if (pendingVerification.has(userId)) {
    const verify = pendingVerification.get(userId);

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

    // 命令只能重发当前题目，不能跳过验证，也不算答错
    if (msg.text && (msg.text === '/start' || msg.text === '/help')) {
      await sendMessage(env, userId, `🧮 请先回答验证问题：\n\n${verify.question}\n\n剩余 ${3 - verify.attempts} 次机会。`);
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
  let questions;
  try {
    questions = getVerifyQuestions(env);
  } catch (error) {
    await sendMessage(env, userId, '❌ 验证暂时不可用，请稍后再试。');
    throw error;
  }
  const question = questions[Math.floor(Math.random() * questions.length)];
  pendingVerification.set(userId, {
    answer: question.answer,
    attempts: 0,
    question: question.question,
  });

  await savePendingToKV(env);

  await sendMessage(
    env,
    userId,
    `🧮 请回答验证问题以证明你是真人:\n\n` +
    `${question.question}\n\n` +
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
        `• 用户发来的消息会进入私有超级群的专属话题\n` +
        `• 在话题中发消息即可回复对应用户\n` +
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
        `💡 在用户对应的话题中发消息即可回复该用户。`
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
    let count = 0;
    let cursor;
    do {
      const page = await env.USER_KV.list(cursor ? { cursor } : {});
      count += page.keys.filter(key => /^\d+$/.test(key.name)).length;
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return count;
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
