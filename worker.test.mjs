import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.js';

const sent = [];
let nextMessageId = 1;
let nextTopicId = 5000;
globalThis.fetch = async (url, options) => {
  const method = new URL(url).pathname.split('/').at(-1);
  const payload = JSON.parse(options.body);
  sent.push({ method, ...payload });
  const result = method === 'createForumTopic'
    ? { message_thread_id: nextTopicId++ }
    : method === 'getChat'
      ? { id: payload.chat_id, type: String(payload.chat_id).startsWith('-100') ? 'supergroup' : 'group', is_forum: String(payload.chat_id).startsWith('-100') }
    : { message_id: sent.length };
  return { json: async () => ({ ok: true, result }) };
};

function createKV() {
  const values = new Map();
  return {
    values,
    get: async key => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key),
    list: async () => ({ keys: [...values.keys()].map(name => ({ name })), list_complete: true }),
  };
}

const kv = createKV();
const topicEnv = { ADMIN_GROUP_ID: '-1001234', USER_KV: kv };

async function deliver(message, extraEnv = {}, activeWorker = worker) {
  const waits = [];
  const env = { BOT_TOKEN: 'test-token', ADMIN_ID: '9999', ...extraEnv };
  const request = new Request('https://example.com/webhook/test-token', {
    method: 'POST',
    body: JSON.stringify({ message: { message_id: nextMessageId++, ...message } }),
  });
  await activeWorker.fetch(request, env, { waitUntil: promise => waits.push(promise) });
  await Promise.all(waits);
  return sent.splice(0);
}

function send(userId, text, extraEnv = {}) {
  return deliver({
    chat: { id: userId, type: 'private' },
    from: { id: userId, first_name: 'Tester' },
    text,
  }, extraEnv);
}

test('custom question requires its answer even after /start and /help', async () => {
  const questions = JSON.stringify([{ question: '联络暗号是什么？', answer: '蓝鲸' }]);
  const config = { ...topicEnv, VERIFY_QUESTIONS: questions };

  let messages = await send(1001, '/start', config);
  assert.match(messages[0].text, /联络暗号是什么/);
  assert.equal(messages.some(message => message.chat_id === '9999'), false);

  messages = await send(1001, '/start', config);
  assert.match(messages[0].text, /请先回答验证问题/);
  assert.equal(messages.some(message => /验证通过/.test(message.text)), false);

  messages = await send(1001, '/help', config);
  assert.match(messages[0].text, /请先回答验证问题/);
  assert.equal(messages.some(message => /验证通过/.test(message.text)), false);

  messages = await send(1001, '错', config);
  assert.match(messages[0].text, /\(1\/3\)/);
  messages = await send(1001, '/start', config);
  assert.match(messages[0].text, /剩余 2 次机会/);

  messages = await send(1001, ' 蓝鲸 ', config);
  assert.match(messages[0].text, /验证通过/);
  messages = await send(1001, '你好', config);
  assert.equal(messages.filter(message => message.method === 'createForumTopic').length, 1);
  assert.equal(messages.some(message => message.method === 'copyMessage' && message.chat_id === '-1001234'), true);
});

test('later messages reuse the topic and only the configured admin can reply', async () => {
  let messages = await send(1001, '第二条消息', topicEnv);
  assert.equal(messages.some(message => message.method === 'createForumTopic'), false);
  assert.equal(messages.some(message => message.method === 'copyMessage' && message.message_thread_id === 5000), true);

  const groupMessage = {
    chat: { id: -1001234, type: 'supergroup' },
    from: { id: 9999, first_name: 'Admin' },
    message_thread_id: 5000,
    text: '管理员回复',
  };
  messages = await deliver(groupMessage, topicEnv);
  assert.equal(messages.some(message => message.method === 'copyMessage' && message.chat_id === '1001'), true);

  messages = await deliver({ ...groupMessage, from: { id: 8888 } }, topicEnv);
  assert.deepEqual(messages, []);
  messages = await deliver({ ...groupMessage, chat: { id: -1009999, type: 'supergroup' } }, topicEnv);
  assert.deepEqual(messages, []);
});

test('admin can get the supergroup ID before configuring it', async () => {
  const messages = await deliver({
    chat: { id: -1001234, type: 'supergroup' },
    from: { id: 9999 },
    text: '/chatid',
  });
  assert.match(messages[0].text, /-1001234/);
});

test('diagnostics distinguish a basic group from a forum supergroup', async () => {
  let messages = await deliver({
    chat: { id: -4711678652, type: 'group' },
    from: { id: 9999 },
    text: '/chatid',
  });
  assert.match(messages[0].text, /类型: group/);
  assert.match(messages[0].text, /升级为超级群/);

  messages = await send(9999, '/config', { ADMIN_GROUP_ID: '-4711678652', USER_KV: kv });
  assert.equal(messages.some(message => message.method === 'getChat'), true);
  assert.equal(messages.some(message => /类型: group/.test(message.text)), true);
});

test('a fresh Worker instance reads both mappings from KV and relays media', async () => {
  const freshWorker = (await import('./worker.js?fresh-instance')).default;
  let messages = await deliver({
    chat: { id: 1001, type: 'private' },
    from: { id: 1001, first_name: 'Tester' },
    photo: [{ file_id: 'photo-file' }],
  }, topicEnv, freshWorker);
  assert.equal(messages.some(message => message.method === 'createForumTopic'), false);
  assert.equal(messages.some(message => message.method === 'copyMessage' && message.message_thread_id === 5000), true);

  messages = await deliver({
    chat: { id: -1001234, type: 'supergroup' },
    from: { id: 9999, first_name: 'Admin' },
    message_thread_id: 5000,
    photo: [{ file_id: 'reply-photo' }],
  }, topicEnv, freshWorker);
  assert.equal(messages.some(message => message.method === 'copyMessage' && message.chat_id === '1001'), true);
});

test('missing topic configuration does not report a successful delivery', async () => {
  const messages = await send(1001, '配置缺失');
  assert.equal(messages.some(message => message.method === 'copyMessage'), false);
  assert.equal(messages.some(message => /消息暂时无法发送/.test(message.text)), true);
});

test('default questions remain active and three wrong answers block the user', async () => {
  let messages = await send(1002, '/start');
  assert.match(messages[0].text, /请回答验证问题/);
  for (let attempt = 0; attempt < 3; attempt++) {
    messages = await send(1002, '肯定错误');
  }
  assert.match(messages[0].text, /已被禁止/);
  assert.deepEqual(await send(1002, '你好'), []);
});

test('invalid custom questions do not fall back to default or verify a user', async () => {
  const messages = await send(1003, '/start', { VERIFY_QUESTIONS: '[]' });
  assert.equal(messages.some(message => message.chat_id === 1003 && /验证暂时不可用/.test(message.text)), true);
  assert.equal(messages.some(message => message.chat_id === 1003 && /请回答验证问题/.test(message.text)), false);
  assert.equal(messages.some(message => message.chat_id === '9999' && message.text.includes('VERIFY_QUESTIONS')), true);
});
