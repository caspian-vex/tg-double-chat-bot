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
        // 异步处理，不阻塞响应
        ctx.waitUntil(handleUpdate(update, env, ctx));
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
      await handleAdminMessage(msg, env);
    } else {
      // 记录用户信息到 KV（如果配置了 USER_KV 存储）
      if (env.USER_KV) {
        ctx.waitUntil(recordUser(env, userId, {
          id: userId,
          first_name: msg.from.first_name,
          last_name: msg.from.last_name,
          username: msg.from.username,
          language_code: msg.from.language_code,
          last_active: Date.now(),
        }));
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

  // 根据消息类型转发给管理员
  try {
    if (msg.text) {
      // 处理命令
      if (msg.text.startsWith('/')) {
        await handleUserCommand(msg, env);
        return;
      }
      const text = `${header}\n\n${escapeHtml(msg.text)}`;
      await sendReplyMarkup(env, env.ADMIN_ID, text, userId, username);
    } else if (msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const caption = msg.caption
        ? `${header}\n\n${escapeHtml(msg.caption)}`
        : header;
      await sendPhotoWithReply(env, env.ADMIN_ID, fileId, caption, userId, username);
    } else if (msg.video) {
      const text = msg.caption
        ? `${header}\n\n${escapeHtml(msg.caption)}`
        : header;
      await sendVideoWithReply(env, env.ADMIN_ID, msg.video.file_id, text, userId, username);
    } else if (msg.document) {
      const text = msg.caption
        ? `${header}\n\n${escapeHtml(msg.caption)}`
        : header;
      await sendDocumentWithReply(env, env.ADMIN_ID, msg.document.file_id, text, userId, username);
    } else if (msg.audio) {
      const text = msg.caption
        ? `${header}\n\n${escapeHtml(msg.caption)}`
        : header;
      await sendAudioWithReply(env, env.ADMIN_ID, msg.audio.file_id, text, userId, username);
    } else if (msg.voice) {
      await sendVoiceWithReply(env, env.ADMIN_ID, msg.voice.file_id, header, userId, username);
    } else if (msg.sticker) {
      await sendSticker(env, env.ADMIN_ID, msg.sticker.file_id);
      // 同时发一条文字说明
      await sendReplyMarkup(env, env.ADMIN_ID, header, userId, username);
    } else if (msg.animation) {
      const text = msg.caption
        ? `${header}\n\n${escapeHtml(msg.caption)}`
        : header;
      await sendAnimationWithReply(env, env.ADMIN_ID, msg.animation.file_id, text, userId, username);
    } else if (msg.video_note) {
      await sendVideoNote(env, env.ADMIN_ID, msg.video_note.file_id);
      await sendReplyMarkup(env, env.ADMIN_ID, header, userId, username);
    } else if (msg.location) {
      const loc = msg.location;
      const text =
        `${header}\n\n📍 位置信息\n经度: ${loc.longitude}\n纬度: ${loc.latitude}`;
      await sendReplyMarkup(env, env.ADMIN_ID, text, userId, username);
      await sendLocation(env, env.ADMIN_ID, loc.latitude, loc.longitude);
    } else if (msg.contact) {
      const c = msg.contact;
      const text =
        `${header}\n\n📇 名片\n姓名: ${c.first_name} ${c.last_name || ''}\n电话: ${c.phone_number}`;
      await sendReplyMarkup(env, env.ADMIN_ID, text, userId, username);
    } else {
      // 不支持的消息类型
      await sendReplyMarkup(env, env.ADMIN_ID, `${header}\n\n⚠️ 用户发送了不支持的消息类型`, userId, username);
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
        `✨ 支持文字、图片、视频、文件、语音等多种消息类型。`
      );
      break;
    case '/help':
      await sendMessage(
        env,
        msg.chat.id,
        `💡 使用说明\n\n` +
        `直接发送消息即可，管理员会收到并回复你。\n\n` +
        `支持的格式：\n` +
        `• 文字消息\n` +
        `• 图片 (带说明文字)\n` +
        `• 视频 / 短视频\n` +
        `• 文件 / 压缩包\n` +
        `• 语音 / 音乐\n` +
        `• 贴纸 / GIF\n` +
        `• 位置 / 名片`
      );
      break;
    default:
      await sendMessage(env, msg.chat.id, `❓ 未知命令，发送 /help 查看帮助`);
  }
}

// ===================== 处理管理员消息 =====================

async function handleAdminMessage(msg, env) {
  // 处理管理员命令
  if (msg.text && msg.text.startsWith('/')) {
    await handleAdminCommand(msg, env);
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
  return '';
}

/**
 * 处理管理员命令
 */
async function handleAdminCommand(msg, env) {
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
        `/broadcast <内容> - 广播消息给所有用户\n` +
        `/help - 帮助`
      );
      break;

    case '/help':
      await sendMessage(
        env,
        env.ADMIN_ID,
        `📋 管理员命令:\n\n` +
        `/stats - 查看机器人统计信息\n` +
        `/broadcast <消息> - 向所有联系过的用户群发\n` +
        `/help - 显示此帮助\n\n` +
        `💡 回复任意用户消息即可回复该用户。`
      );
      break;

    case '/stats':
      // 简单统计 - 从 KV 获取数据（如果有配置 KV）
      const userCount = env.USER_KV
        ? await getUserCount(env)
        : '未配置 KV 存储';
      await sendMessage(
        env,
        env.ADMIN_ID,
        `📊 机器人统计\n\n` +
        `👤 联系过的用户: ${userCount}\n` +
        `🤖 机器人状态: 运行中`
      );
      break;

    case '/broadcast': {
      if (!env.USER_KV) {
        await sendMessage(env, env.ADMIN_ID, '❌ 广播功能需要配置 KV 命名空间 (USER_KV)');
        return;
      }
      const broadcastText = args.join(' ');
      if (!broadcastText) {
        await sendMessage(env, env.ADMIN_ID, '❌ 请提供广播内容: /broadcast <消息>');
        return;
      }
      await sendMessage(env, env.ADMIN_ID, '📢 广播发送中...');
      const { success, fail } = await broadcastToUsers(env, broadcastText);
      await sendMessage(
        env,
        env.ADMIN_ID,
        `📢 广播完成\n✅ 成功: ${success}\n❌ 失败: ${fail}`
      );
      break;
    }

    default:
      await sendMessage(env, env.ADMIN_ID, `❓ 未知命令，输入 /help 查看帮助`);
  }
}

/**
 * 广播消息给所有用户（需要 KV 存储）
 */
async function broadcastToUsers(env, text) {
  let success = 0;
  let fail = 0;
  try {
    const allUsers = await env.USER_KV.list();
    for (const key of allUsers.keys) {
      try {
        await sendMessage(env, parseInt(key.name), `📢 管理员广播:\n\n${escapeHtml(text)}`);
        success++;
      } catch {
        fail++;
      }
    }
  } catch (e) {
    console.error('广播失败:', e);
  }
  return { success, fail };
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
