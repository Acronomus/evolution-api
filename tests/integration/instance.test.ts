/**
 * Ciclo de vida da instância (/instance/*) com o socket falso da baileys, incluindo
 * as correções do build próprio:
 * - restart recusado enquanto o QR está na tela (b8ca7824);
 * - delete segue até a limpeza mesmo quando o logout falha (57de1b5f);
 * - fetchInstances omite o token quando AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=false (1205e2ff);
 * - a query string não troca a instância autenticada pelo path (cbcc7ce2).
 */
import { prismaRepository, waMonitor } from '@api/server.module';
import { beforeEach, describe, expect, it } from 'vitest';

import { api, GLOBAL_KEY } from './helpers/app';
import { resetDb, settle } from './helpers/db';
import { sockets } from './helpers/fakeBaileys';
import { connectOpen, connectWithQr, createInstance } from './helpers/instances';

beforeEach(resetDb);

describe('POST /instance/create', () => {
  it('cria a instância no banco e devolve o token', async () => {
    const { token, body } = await createInstance('loja-a');

    expect(token).toMatch(/^[0-9A-F-]{36}$/);
    expect(body.instance).toMatchObject({ instanceName: 'loja-a', integration: 'WHATSAPP-BAILEYS', status: 'close' });
    const row = await prismaRepository.instance.findUnique({ where: { name: 'loja-a' } });
    expect(row).toMatchObject({ token, integration: 'WHATSAPP-BAILEYS' });
    expect(sockets).toHaveLength(0);
  });

  it('exige a chave global (o token de outra instância não serve)', async () => {
    const { token } = await createInstance('loja-a');
    const http = await api();

    const noKey = await http.post('/instance/create').send({ instanceName: 'x', integration: 'WHATSAPP-BAILEYS' });
    expect(noKey.status).toBe(401);
    const otherToken = await http
      .post('/instance/create')
      .set({ apikey: token })
      .send({ instanceName: 'x', integration: 'WHATSAPP-BAILEYS' });
    expect(otherToken.status).toBe(401);
  });

  it('recusa nome repetido', async () => {
    await createInstance('loja-a');
    const res = await (
      await api()
    )
      .post('/instance/create')
      .set(GLOBAL_KEY)
      .send({ instanceName: 'loja-a', integration: 'WHATSAPP-BAILEYS' });
    expect(res.status).toBe(403);
  });
});

describe('GET /instance/connect e /instance/connectionState', () => {
  it('conectar abre um socket e o QR deixa a instância em connecting', async () => {
    await createInstance('loja-a');
    await connectWithQr('loja-a', { viaRoute: true });

    const res = await (await api()).get('/instance/connectionState/loja-a').set(GLOBAL_KEY);
    expect(res.body).toEqual({ instance: { instanceName: 'loja-a', state: 'connecting' } });
    expect(sockets).toHaveLength(1);
  });

  it('instância que não existe dá 404', async () => {
    const res = await (await api()).get('/instance/connectionState/fantasma').set(GLOBAL_KEY);
    expect(res.status).toBe(404);
  });
});

describe('POST /instance/restart', () => {
  it('é recusado enquanto o QR está na tela, sem derrubar o socket', async () => {
    await createInstance('loja-a');
    const socket = await connectWithQr('loja-a');

    const res = await (await api()).post('/instance/restart/loja-a').set(GLOBAL_KEY);

    // A mensagem do BadRequestException se perde no `error.toString()` do controller
    // e chega como "[object Object]" (comportamento do upstream, ver CLAUDE.md).
    expect(res.body).toMatchObject({ error: true });
    expect(socket.end).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  it('com a instância aberta, encerra o socket com 515 e reconecta uma vez só', async () => {
    await createInstance('loja-a');
    const first = await connectOpen('loja-a');

    const res = await (await api()).post('/instance/restart/loja-a').set(GLOBAL_KEY);
    await settle('loja-a');

    expect(res.status).toBe(200);
    // 1ª chamada: restart() com 515. 2ª: o createClient da reconexão encerrando o
    // anterior, que já está fechado (no-op, como na baileys).
    expect((first.end.mock.calls[0][0] as any)?.output?.statusCode).toBe(515);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].closed).toBe(false);
  });
});

describe('reconexão com o socket anterior ainda aberto', () => {
  /**
   * BUG CONHECIDO do build próprio (b8ca7824), não corrigido neste PR.
   *
   * O createClient desliga `connection.update` do socket anterior e chama `end()`.
   * Mas o app escuta pelo `ev.process`, que na baileys assina o evento genérico
   * `event` (lib/Utils/event-buffer.js): `removeAllListeners('connection.update')`
   * não o desliga. O close do anterior chega ao connectionUpdate sem statusCode,
   * vira reconexão, que fecha o novo socket, e assim em laço.
   *
   * Em produção: reloadConnection(), chamado por /chat/updatePrivacySettings,
   * /chat/updateProfilePicture e /chat/removeProfilePicture com a instância aberta.
   *
   * `it.fails`: o teste descreve o comportamento certo. Quando o bug for corrigido
   * ele passa a falhar; aí é só trocar `it.fails` por `it`.
   */
  it.fails('encerra o anterior sem disparar outra reconexão', async () => {
    await createInstance('loja-a');
    const first = await connectOpen('loja-a');
    const instance = waMonitor.waInstances['loja-a'];

    try {
      await instance.reloadConnection();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(first.closed).toBe(true);
      expect(sockets).toHaveLength(2);
    } finally {
      // Para o laço antes do próximo teste.
      instance.connectToWhatsapp = async () => undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await settle('loja-a');
    }
  });
});

describe('DELETE /instance/logout e /instance/delete', () => {
  it('logout encerra a sessão do WhatsApp', async () => {
    await createInstance('loja-a');
    const socket = await connectOpen('loja-a');

    const res = await (await api()).delete('/instance/logout/loja-a').set(GLOBAL_KEY);
    await settle('loja-a');

    expect(res.status).toBe(200);
    expect(socket.logout).toHaveBeenCalled();
  });

  it('delete remove a instância mesmo quando o logout estoura', async () => {
    await createInstance('loja-a');
    const socket = await connectOpen('loja-a');
    socket.logout.mockRejectedValueOnce(new Error('Connection Closed'));

    const res = await (await api()).delete('/instance/delete/loja-a').set(GLOBAL_KEY);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(res.status).toBe(200);
    expect(waMonitor.waInstances['loja-a']).toBeUndefined();
    expect(await prismaRepository.instance.findUnique({ where: { name: 'loja-a' } })).toBeNull();
  });
});

describe('GET /instance/fetchInstances', () => {
  it('com a chave global lista todas, sem o token', async () => {
    await createInstance('loja-a');
    await createInstance('loja-b');

    const res = await (await api()).get('/instance/fetchInstances').set(GLOBAL_KEY);

    expect(res.status).toBe(200);
    expect(res.body.map((i: any) => i.name).sort()).toEqual(['loja-a', 'loja-b']);
    for (const instance of res.body) expect(instance.token).toBeUndefined();
  });

  it('com o token de uma instância lista só ela', async () => {
    const { token } = await createInstance('loja-a');
    await createInstance('loja-b');

    const res = await (await api()).get('/instance/fetchInstances').set({ apikey: token });

    expect(res.status).toBe(200);
    expect(res.body.map((i: any) => i.name)).toEqual(['loja-a']);
  });

  it('token desconhecido dá 401', async () => {
    await createInstance('loja-a');
    const res = await (await api()).get('/instance/fetchInstances').set({ apikey: 'nao-existe' });
    expect(res.status).toBe(401);
  });
});

describe('isolamento entre instâncias', () => {
  it('o token de uma instância não acessa outra pelo path', async () => {
    const { token } = await createInstance('loja-a');
    await createInstance('loja-b');

    const res = await (await api()).get('/instance/connectionState/loja-b').set({ apikey: token });
    expect(res.status).toBe(401);
  });

  it('a query string não troca a instância autenticada', async () => {
    const { token } = await createInstance('loja-a');
    await createInstance('loja-b');

    const res = await (await api()).get('/instance/connectionState/loja-a?instanceName=loja-b').set({ apikey: token });

    expect(res.status).toBe(200);
    expect(res.body.instance.instanceName).toBe('loja-a');
  });
});
