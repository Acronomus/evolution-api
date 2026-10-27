/**
 * Consultas do histórico (/chat/find*), configurações da instância (/settings)
 * e checagem de números (/chat/whatsappNumbers). Os dados entram pelo mesmo
 * caminho de produção: eventos da baileys (socket falso) gravados pelo app.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prismaRepository } from '@api/server.module';

import { api, GLOBAL_KEY } from './helpers/app';
import { resetDb } from './helpers/db';
import { FakeSocket } from './helpers/fakeBaileys';
import { connectOpen, createInstance } from './helpers/instances';

const PHONE = '5511988887777@s.whatsapp.net';
let socket: FakeSocket;
let tokenA: string;

beforeEach(async () => {
  await resetDb();
  ({ token: tokenA } = await createInstance('loja-a'));
  socket = await connectOpen('loja-a');
});

const receiveText = async (remoteJid: string, text: string) => {
  const before = await prismaRepository.message.count();
  socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { remoteJid, fromMe: false, id: `IN${Math.random().toString(16).slice(2, 10).toUpperCase()}` },
        message: { conversation: text },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Cliente',
      },
    ],
  });
  await vi.waitFor(async () => expect(await prismaRepository.message.count()).toBe(before + 1), { timeout: 5000 });
};

describe('POST /chat/findMessages', () => {
  it('devolve as mensagens do chat pedido', async () => {
    await receiveText(PHONE, 'primeira');
    await receiveText('5511977776666@s.whatsapp.net', 'de outro');

    const res = await (
      await api()
    )
      .post('/chat/findMessages/loja-a')
      .set(GLOBAL_KEY)
      .send({ where: { key: { remoteJid: PHONE } } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.messages.total).toBe(1);
    expect(res.body.messages.records[0].message).toMatchObject({ conversation: 'primeira' });
  });

  it('uma instância não vê as mensagens de outra', async () => {
    await receiveText(PHONE, 'da loja a');
    const { token: tokenB } = await createInstance('loja-b');

    const res = await (await api()).post('/chat/findMessages/loja-b').set({ apikey: tokenB }).send({});

    expect(res.status).toBe(200);
    expect(res.body.messages.total).toBe(0);
  });
});

describe('POST /chat/findChats e /chat/findContacts', () => {
  it('lista o chat e o contato criados pela mensagem recebida', async () => {
    await receiveText(PHONE, 'oi');
    const http = await api();

    await vi.waitFor(
      async () => {
        const chats = await http.post('/chat/findChats/loja-a').set({ apikey: tokenA }).send({});
        expect(chats.status).toBe(200);
        expect(chats.body.map((c: any) => c.remoteJid)).toContain(PHONE);
      },
      { timeout: 5000 },
    );

    const contacts = await http.post('/chat/findContacts/loja-a').set({ apikey: tokenA }).send({});
    expect(contacts.status).toBe(200);
    expect(contacts.body.map((c: any) => c.remoteJid)).toContain(PHONE);
  });
});

describe('POST /chat/whatsappNumbers', () => {
  it('pergunta ao WhatsApp e devolve se o número existe', async () => {
    const res = await (
      await api()
    )
      .post('/chat/whatsappNumbers/loja-a')
      .set(GLOBAL_KEY)
      .send({ numbers: ['5511988887777'] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[0]).toMatchObject({ exists: true, jid: PHONE });
  });
});

describe('POST /settings/set e GET /settings/find', () => {
  it('grava e lê as configurações', async () => {
    const http = await api();
    const settings = {
      rejectCall: true,
      msgCall: 'Não atendemos ligações',
      groupsIgnore: true,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
    };

    const set = await http.post('/settings/set/loja-a').set(GLOBAL_KEY).send(settings);
    expect(set.status, JSON.stringify(set.body)).toBe(201);

    const find = await http.get('/settings/find/loja-a').set(GLOBAL_KEY);
    expect(find.body).toMatchObject(settings);
  });

  it('recusa corpo incompleto', async () => {
    const res = await (await api()).post('/settings/set/loja-a').set(GLOBAL_KEY).send({ rejectCall: true });
    expect(res.status).toBe(400);
  });
});
