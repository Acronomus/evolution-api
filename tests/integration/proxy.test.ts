/**
 * Proxy por instância. Correções do build próprio:
 * - o `fetchAgent` (upload de mídia) é um agent clássico de node:http, não um
 *   ProxyAgent do undici, que a baileys rc13+ recusa (20e42959);
 * - os `fetch` da baileys (mídia recebida, foto de perfil) passam pelo proxy via
 *   `options.dispatcher`, e a mídia recebida usa o mesmo dispatcher (42834e4d);
 * - mídia em URL própria (S3, backend) é baixada sem proxy e entregue em buffer.
 */
import http from 'node:http';

import { prismaRepository, proxyController, waMonitor } from '@api/server.module';
import axios from 'axios';
import nock from 'nock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api, GLOBAL_KEY } from './helpers/app';
import { resetDb } from './helpers/db';
import { connectOpen, createInstance } from './helpers/instances';

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
});

const PROXY = {
  enabled: true,
  host: 'proxy.example.test',
  port: '3128',
  protocol: 'http',
  username: 'u',
  password: 'p',
};

/**
 * O testProxy (código do upstream) compara o IP de saída sem e com o proxy em
 * icanhazip.com; o pedido pelo proxy é um túnel CONNECT que o nock não intercepta.
 * Aqui ele é substituído pela resposta que o teste quer.
 */
const mockProxyCheck = (works: boolean) => vi.spyOn(proxyController, 'testProxy').mockResolvedValue(works);

/** Grava o proxy direto no banco (o caminho pela rota está testado acima). */
const saveProxy = async (instanceName: string) => {
  await prismaRepository.proxy.create({
    data: { ...PROXY, instanceId: waMonitor.waInstances[instanceName].instanceId },
  });
};

describe('POST /proxy/set e GET /proxy/find', () => {
  it('grava o proxy quando ele muda o IP de saída', async () => {
    await createInstance('loja-a');
    mockProxyCheck(true);
    const http_ = await api();

    const set = await http_.post('/proxy/set/loja-a').set(GLOBAL_KEY).send(PROXY);
    expect(set.status, JSON.stringify(set.body)).toBe(201);

    const find = await http_.get('/proxy/find/loja-a').set(GLOBAL_KEY);
    expect(find.body).toMatchObject({ enabled: true, host: PROXY.host, port: PROXY.port });
  });

  it('recusa proxy que não muda o IP', async () => {
    await createInstance('loja-a');
    mockProxyCheck(false);

    const res = await (await api()).post('/proxy/set/loja-a').set(GLOBAL_KEY).send(PROXY);
    expect(res.status).toBe(400);
  });
});

describe('socket com proxy', () => {
  it('agent e fetchAgent são agents de node:http e os fetch da baileys levam o dispatcher', async () => {
    await createInstance('loja-a');
    await saveProxy('loja-a');

    const socket = await connectOpen('loja-a');
    const config = socket.config as any;

    expect(config.agent).toBeInstanceOf(http.Agent);
    expect(config.fetchAgent).toBeInstanceOf(http.Agent);
    expect(config.agent).not.toBe(config.fetchAgent);
    expect(config.options?.dispatcher).toBeDefined();
    expect(waMonitor.waInstances['loja-a'].mediaDownloadOptions).toEqual({
      options: { dispatcher: config.options.dispatcher },
    });
  });

  it('sem proxy não há dispatcher nem opções de download', async () => {
    await createInstance('loja-a');
    const socket = await connectOpen('loja-a');

    expect((socket.config as any).fetchAgent).toBeUndefined();
    expect((socket.config as any).options?.dispatcher).toBeUndefined();
    expect(waMonitor.waInstances['loja-a'].mediaDownloadOptions).toEqual({});
  });

  it('documento em URL própria é baixado sem proxy e enviado como buffer', async () => {
    await createInstance('loja-a');
    await saveProxy('loja-a');
    const socket = await connectOpen('loja-a');

    const pdf = Buffer.from('%PDF-1.4 teste');
    nock('https://arquivos.example.test').get('/boleto.pdf').reply(200, pdf, { 'Content-Type': 'application/pdf' });
    const get = vi.spyOn(axios, 'get');

    const res = await (await api()).post('/message/sendMedia/loja-a').set(GLOBAL_KEY).send({
      number: '5511988887777',
      mediatype: 'document',
      mimetype: 'application/pdf',
      fileName: 'boleto.pdf',
      media: 'https://arquivos.example.test/boleto.pdf',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const download = get.mock.calls.find(([url]) => url === 'https://arquivos.example.test/boleto.pdf');
    expect(download?.[1]).toEqual({ responseType: 'arraybuffer' });
    expect(socket.waUploadToServer).toHaveBeenCalled();
    expect(socket.sendMessage).toHaveBeenCalled();
    get.mockRestore();
  });
});
