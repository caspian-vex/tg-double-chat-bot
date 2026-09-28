import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.js';

const sent = [];
globalThis.fetch = async (url, options) => {
  const method = new URL(url).pathname.split('/').at(-1);
  sent.push({ method, ...JSON.parse(options.body) });
  return { json: async () => ({ ok: true, result: { message_id: sent.length } }) };
};

async function send(userId, text, extraEnv = {}) {
  const waits = [];
  const env = { BOT_TOKEN: 'test-token', ADMIN_ID: '9999', ...extraEnv };
  const request = new Request('https://example.com/webhook/test-token', {
    method: 'POST',
    body: JSON.stringify({
      message: {
        chat: { id: userId, type: 'private' },
        from: { id: userId, first_name: 'Tester' },
        text,
      },
    }),
  });
  await worker.fetch(request, env, { waitUntil: promise => waits.push(promise) });
  await Promise.all(waits);
  return sent.splice(0);
}

test('custom question requires its answer even after /start and /help', async () => {
  const questions = JSON.stringify([{ question: '联络暗号是什么？', answer: '蓝鲸' }]);
  const config = { VERIFY_QUESTIONS: questions };

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
  assert.equal(messages.some(message => message.chat_id === '9999' && message.text.includes('你好')), true);
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
