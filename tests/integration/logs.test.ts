/**
 * `GET /logs` e a ferramenta `evolution_logs` do MCP (build próprio): consulta do buffer de
 * stdout/stderr. O buffer é instalado em streams falsos, para o teste escrever as linhas.
 */
import { installLogCapture } from '@api/logs/log.buffer';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { api, getApp, GLOBAL_KEY } from './helpers/app';
import { resetDb } from './helpers/db';
import { createInstance } from './helpers/instances';

const out = { write: (_c: any) => true };
const err = { write: (_c: any) => true };
const buffer = installLogCapture(1000, { stdout: out, stderr: err });

const LINES = [
  '[Evolution API] [loja-a] 1 - Fri Nov 13 2026 10:00:00   INFO  [ChannelStartupService] [string] conectou\n',
  "[Evolution API] [loja-b] 1 - Fri Nov 13 2026 10:00:01   ERROR  [ChannelStartupService] [string] Connection Closed apikey: 'SEGREDO'\n",
  '[Evolution API] [loja-a] 1 - Fri Nov 13 2026 10:00:02   WARN  [WebhookService] [string] retry 3\n',
];
LINES.forEach((l) => out.write(l));
err.write('Error: boom\n    at foo (x.ts:1)\n');

beforeEach(resetDb);

describe('GET /logs', () => {
  it('devolve as últimas linhas, com filtros', async () => {
    const http_ = await api();
    const all = await http_.get('/logs').set(GLOBAL_KEY);
    expect(all.status).toBe(200);
    expect(all.body.buffered).toBe(buffer.query().buffered);
    expect(all.body.lines.at(-1)).toMatchObject({ stream: 'stderr', text: '    at foo (x.ts:1)' });
    expect(all.body.lines[0].time).toMatch(/^\d{4}-\d\d-\d\dT/);

    const tail = await http_.get('/logs?tail=2').set(GLOBAL_KEY);
    expect(tail.body.lines.map((l: any) => l.text)).toEqual(['Error: boom', '    at foo (x.ts:1)']);

    const errors = await http_.get('/logs').query({ level: 'error,warn', instance: 'loja-a' }).set(GLOBAL_KEY);
    expect(errors.body.lines.map((l: any) => l.text)).toEqual([expect.stringContaining('retry 3')]);

    const grep = await http_.get('/logs').query({ grep: 'retry \\d', regex: 'true', since: '1h' }).set(GLOBAL_KEY);
    expect(grep.body.matched).toBe(1);

    const stderr = await http_.get('/logs?stream=stderr').set(GLOBAL_KEY);
    expect(stderr.body.matched).toBe(2);
  });

  it('parâmetro inválido responde 400 com a mensagem', async () => {
    const http_ = await api();
    for (const [q, msg] of [
      [{ grep: '(', regex: 'true' }, /regex inválido/],
      [{ since: 'ontem' }, /since inválido/],
      [{ tail: '0' }, /tail inválido/],
      [{ level: 'FATAL' }, /level inválido/],
      [{ stream: 'stdin' }, /stream inválido/],
    ] as const) {
      const res = await http_.get('/logs').query(q).set(GLOBAL_KEY);
      expect(res.status, JSON.stringify(q)).toBe(400);
      expect(res.body.response.message[0]).toMatch(msg);
    }
  });

  it('sem chave responde 401; token de instância responde 403', async () => {
    const { token } = await createInstance('loja-a');
    const http_ = await api();
    expect((await http_.get('/logs')).status).toBe(401);
    expect((await http_.get('/logs').set({ apikey: token })).status).toBe(403);
    expect((await http_.get('/logs').set({ apikey: 'chave-errada' })).status).toBe(403);
  });
});

describe('ferramenta evolution_logs pelo /mcp', () => {
  let server: http.Server;
  let mcpUrl: URL;
  let clients: Client[] = [];
  beforeAll(async () => {
    server = http.createServer(await getApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    mcpUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  });
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    clients = [];
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const connect = async (headers: Record<string, string>) => {
    const client = new Client({ name: 'teste-logs', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers } }));
    clients.push(client);
    return client;
  };

  it('chave global consulta os logs, com segredos mascarados', async () => {
    const client = await connect(GLOBAL_KEY);
    const r: any = await client.callTool({ name: 'evolution_logs', arguments: { level: ['ERROR'] } });
    expect(r.isError).toBeFalsy();
    const text = r.content[0].text as string;
    expect(text).toContain('1 de 1 linha(s)');
    expect(text).toContain('Connection Closed');
    expect(text).not.toContain('SEGREDO');
  });

  it('token de instância não recebe a ferramenta', async () => {
    const { token } = await createInstance('loja-a');
    const client = await connect({ apikey: token });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('evolution_logs');
  });
});
