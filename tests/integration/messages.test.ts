/**
 * Mensagens com o socket falso da baileys, cobrindo as correções do build próprio
 * para contatos @lid:
 * - o webhook de messages.upsert troca remoteJid/remoteJidAlt em vez de perder o LID (ac033316);
 * - envio para @lid passa na validação do onWhatsApp (225e0af1);
 * - markMessageAsRead aceita @lid e ignora broadcast/newsletter (efb550cb);
 * - getLastMessage filtra pelo campo JSON key.remoteJid (b38a5219), usado em archiveChat.
 */
import { prismaRepository } from '@api/server.module';
import nock from 'nock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, GLOBAL_KEY } from './helpers/app';
import { resetDb, settle } from './helpers/db';
import { FakeSocket } from './helpers/fakeBaileys';
import { connectOpen, createInstance } from './helpers/instances';

const LID = '123456789012345@lid';
const PHONE = '5511988887777@s.whatsapp.net';
const HOOK = 'https://hooks.example.test';

let socket: FakeSocket;

beforeEach(async () => {
  await resetDb();
  await createInstance('loja-a');
  socket = await connectOpen('loja-a');
});

const receive = (key: Record<string, unknown>, text = 'oi') =>
  socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { fromMe: false, id: `IN${Math.random().toString(16).slice(2, 10).toUpperCase()}`, ...key },
        message: { conversation: text },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: 'Cliente',
      },
    ],
  });

describe('POST /webhook/set e messages.upsert', () => {
  it('configura o webhook da instância', async () => {
    const http = await api();
    const set = await http
      .post('/webhook/set/loja-a')
      .set(GLOBAL_KEY)
      .send({ webhook: { enabled: true, url: `${HOOK}/evo`, events: ['MESSAGES_UPSERT'] } });
    expect(set.status).toBe(201);

    const find = await http.get('/webhook/find/loja-a').set(GLOBAL_KEY);
    expect(find.body).toMatchObject({ enabled: true, url: `${HOOK}/evo`, events: ['MESSAGES_UPSERT'] });
  });

  it('mensagem de contato @lid sai no webhook com o telefone em remoteJid e o LID em remoteJidAlt', async () => {
    await (
      await api()
    )
      .post('/webhook/set/loja-a')
      .set(GLOBAL_KEY)
      .send({ webhook: { enabled: true, url: `${HOOK}/evo`, events: ['MESSAGES_UPSERT'] } });

    let payload: any;
    nock(HOOK)
      .post('/evo', (body) => (payload = body))
      .reply(200);

    receive({ remoteJid: LID, remoteJidAlt: PHONE });

    await vi.waitFor(() => expect(payload).toBeDefined(), { timeout: 5000 });
    expect(payload.event).toBe('messages.upsert');
    expect(payload.data.key).toMatchObject({ remoteJid: PHONE, remoteJidAlt: LID });

    // No banco a key original continua com o LID.
    await settle('loja-a');
    const stored = await prismaRepository.message.findFirst({ where: { instanceId: payload.data.instanceId } });
    expect((stored?.key as any)?.remoteJid).toBe(LID);
  });
});

describe('POST /message/sendText', () => {
  it('envia para número comum', async () => {
    const res = await (
      await api()
    )
      .post('/message/sendText/loja-a')
      .set(GLOBAL_KEY)
      .send({ number: '5511988887777', text: 'olá' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(socket.sendMessage).toHaveBeenCalledWith(PHONE, expect.objectContaining({ text: 'olá' }), expect.anything());
  });

  it('envia para contato @lid mesmo sem o onWhatsApp confirmar', async () => {
    socket.onWhatsApp.mockResolvedValue([]);

    const res = await (await api()).post('/message/sendText/loja-a').set(GLOBAL_KEY).send({ number: LID, text: 'olá' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(socket.sendMessage).toHaveBeenCalledWith(LID, expect.objectContaining({ text: 'olá' }), expect.anything());
  });

  it('número que não está no WhatsApp é recusado', async () => {
    socket.onWhatsApp.mockResolvedValue([{ jid: PHONE, exists: false }]);

    const res = await (
      await api()
    )
      .post('/message/sendText/loja-a')
      .set(GLOBAL_KEY)
      .send({ number: '5511988887777', text: 'olá' });

    expect(res.status).toBe(400);
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });
});

describe('POST /chat/markMessageAsRead', () => {
  it('marca @lid e @s.whatsapp.net e ignora broadcast', async () => {
    const res = await (
      await api()
    )
      .post('/chat/markMessageAsRead/loja-a')
      .set(GLOBAL_KEY)
      .send({
        readMessages: [
          { remoteJid: LID, fromMe: false, id: 'A1' },
          { remoteJid: PHONE, fromMe: false, id: 'A2' },
          { remoteJid: 'status@broadcast', fromMe: false, id: 'A3' },
        ],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(socket.readMessages).toHaveBeenCalledWith([
      { remoteJid: LID, fromMe: false, id: 'A1' },
      { remoteJid: PHONE, fromMe: false, id: 'A2' },
    ]);
  });
});

describe('POST /chat/archiveChat', () => {
  it('acha a última mensagem do chat pelo key.remoteJid gravado no banco', async () => {
    receive({ remoteJid: PHONE }, 'primeira');
    await vi.waitFor(async () => expect(await prismaRepository.message.count()).toBe(1), { timeout: 5000 });
    const stored = await prismaRepository.message.findFirst();

    const res = await (
      await api()
    )
      .post('/chat/archiveChat/loja-a')
      .set(GLOBAL_KEY)
      .send({ chat: PHONE, archive: true });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(socket.chatModify).toHaveBeenCalledTimes(1);
    const [modification] = socket.chatModify.mock.calls[0] as any[];
    expect(modification.lastMessages[0].key.id).toBe((stored?.key as any).id);
  });

  it('chat sem mensagens dá erro', async () => {
    const res = await (
      await api()
    )
      .post('/chat/archiveChat/loja-a')
      .set(GLOBAL_KEY)
      .send({ chat: PHONE, archive: true });

    expect(res.status).toBe(500);
    expect(socket.chatModify).not.toHaveBeenCalled();
  });
});
