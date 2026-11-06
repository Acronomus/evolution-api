/**
 * Servidor MCP em /mcp (build próprio): cliente MCP real (Streamable HTTP) contra o app
 * escutando numa porta local. Cada ferramenta chama a própria API REST por loopback com a
 * apikey de quem chamou, então a autorização é a dos guards.
 */
import { prismaRepository, waMonitor } from '@api/server.module';
import { configService } from '@config/env.config';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TEST_API_KEY } from '../testEnv';
import { api, getApp, GLOBAL_KEY } from './helpers/app';
import { resetDb } from './helpers/db';
import { createInstance } from './helpers/instances';

beforeEach(resetDb);

let clients: Client[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  clients = [];
});

let server: http.Server;
let mcpUrl: URL;
beforeAll(async () => {
  server = http.createServer(await getApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mcpUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const connect = async (headers: Record<string, string>) => {
  const client = new Client({ name: 'teste-integracao', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers } });
  await client.connect(transport);
  clients.push(client);
  return client;
};

const text = (r: any) => r.content.find((c: any) => c.type === 'text')?.text as string;
const json = (r: any) => JSON.parse(text(r));

describe('POST /mcp: autenticação', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  };

  it('sem apikey responde 401 com desafio Bearer', async () => {
    const res = await (await api()).post('/mcp').set('accept', 'application/json, text/event-stream').send(initialize);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
  });

  it('apikey que não é a global nem token de instância responde 401', async () => {
    await createInstance('loja-a');
    const res = await (
      await api()
    )
      .post('/mcp')
      .set({ apikey: 'chave-errada', accept: 'application/json, text/event-stream' })
      .send(initialize);
    expect(res.status).toBe(401);
  });

  it('aceita a chave em Authorization: Bearer', async () => {
    const client = await connect({ authorization: `Bearer ${TEST_API_KEY}` });
    expect((await client.listTools()).tools.length).toBe(25);
  });

  it('desligado (MCP_ENABLED=false) responde 404', async () => {
    const get = configService.get.bind(configService);
    vi.spyOn(configService, 'get').mockImplementation(((key: string) =>
      key === 'MCP' ? { ...get('MCP' as any), ENABLED: false } : get(key as any)) as any);
    const res = await (await api()).post('/mcp').set(GLOBAL_KEY).send(initialize);
    expect(res.status).toBe(404);
  });
});

describe('GET e DELETE /mcp', () => {
  it('não há sessão: GET e DELETE respondem 405', async () => {
    const http_ = await api();
    const get = await http_.get('/mcp').set({ ...GLOBAL_KEY, accept: 'text/event-stream' });
    const del = await http_.delete('/mcp').set(GLOBAL_KEY);
    expect(get.status).toBe(405);
    expect(del.status).toBe(405);
  });
});

describe('chave global', () => {
  it('cria, lista, edita e exclui instância pelas ferramentas', async () => {
    const client = await connect(GLOBAL_KEY);

    const created = await client.callTool({
      name: 'evolution_instance_create',
      arguments: { instanceName: 'via-mcp', qrcode: false, rejectCall: true, msgCall: 'Não atendo' },
    });
    expect(created.isError, text(created)).toBeFalsy();
    expect(json(created).hash).toBe('[oculto]');
    const row = await prismaRepository.instance.findUnique({ where: { name: 'via-mcp' } });
    expect(row?.token).toMatch(/^[0-9A-F-]{36}$/);

    const list = json(await client.callTool({ name: 'evolution_instance_list', arguments: {} }));
    expect(list.map((i: any) => i.name)).toEqual(['via-mcp']);

    const upd = await client.callTool({
      name: 'evolution_instance_settings_update',
      arguments: { instanceName: 'via-mcp', groupsIgnore: true },
    });
    expect(upd.isError, text(upd)).toBeFalsy();
    const settings = await prismaRepository.setting.findFirst({ where: { instanceId: row!.id } });
    expect(settings).toMatchObject({ rejectCall: true, msgCall: 'Não atendo', groupsIgnore: true });

    const refused = await client.callTool({
      name: 'evolution_instance_delete',
      arguments: { instanceName: 'via-mcp', confirm: 'outro-nome' },
    });
    expect(refused.isError).toBe(true);
    expect(await prismaRepository.instance.count({ where: { name: 'via-mcp' } })).toBe(1);

    const del = await client.callTool({
      name: 'evolution_instance_delete',
      arguments: { instanceName: 'via-mcp', confirm: 'via-mcp' },
    });
    expect(del.isError, text(del)).toBeFalsy();
    await vi.waitFor(async () => expect(await prismaRepository.instance.count({ where: { name: 'via-mcp' } })).toBe(0));
    expect(waMonitor.waInstances['via-mcp']).toBeUndefined();
  });

  it('instância de MCP_PROTECTED_INSTANCES não é apagada', async () => {
    await createInstance('protegida');
    const client = await connect(GLOBAL_KEY);
    const r = await client.callTool({
      name: 'evolution_instance_delete',
      arguments: { instanceName: 'protegida', confirm: 'protegida' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('protegida');
    expect(await prismaRepository.instance.count({ where: { name: 'protegida' } })).toBe(1);
  });
});

describe('token de instância', () => {
  it('só enxerga a própria instância e não cria outras', async () => {
    const { token } = await createInstance('loja-a');
    await createInstance('loja-b');
    const client = await connect({ apikey: token });

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('evolution_instance_create');

    const list = json(await client.callTool({ name: 'evolution_instance_list', arguments: {} }));
    expect(list.map((i: any) => i.name)).toEqual(['loja-a']);

    const own = await client.callTool({
      name: 'evolution_instance_settings_get',
      arguments: { instanceName: 'loja-a' },
    });
    expect(own.isError, text(own)).toBeFalsy();

    const other = await client.callTool({
      name: 'evolution_instance_settings_get',
      arguments: { instanceName: 'loja-b' },
    });
    expect(other.isError).toBe(true);
    expect(text(other)).toContain('401');
  });
});
