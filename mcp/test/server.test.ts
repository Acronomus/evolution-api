// Testa o MCP inteiro (cliente MCP real ↔ servidor em memória) com a Evolution trocada por um
// fetch falso. Nada de rede: as respostas abaixo são montadas a partir dos controllers do fork
// (src/api/controllers, src/api/integrations), não gravadas de um servidor real.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../src/config.js';
import { createEvolutionClient } from '../src/evolution.js';
import { MASK } from '../src/redact.js';
import { createServer } from '../src/server.js';

type Call = { method: string; path: string; headers: Record<string, string>; body: any };
type Route = (call: Call) => { status?: number; body: unknown } | undefined;

const BASE = 'http://evolution.test';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const baseConfig: Config = {
  url: BASE,
  apiKey: 'chave-global-teste',
  mode: 'write',
  protectedInstances: [],
  showSecrets: false,
  timeoutMs: 1000,
};

let clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function setup(routes: Record<string, Route | { status?: number; body: unknown }>, config: Partial<Config> = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method ?? 'GET',
      path: u.pathname + u.search,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${u.pathname}`;
    const route = routes[key];
    const res = typeof route === 'function' ? route(call) : route;
    if (!res) return new Response(JSON.stringify({ status: 404, error: 'Not Found', response: { message: [`sem rota ${key}`] } }), { status: 404 });
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
  }) as unknown as typeof fetch;

  const cfg = { ...baseConfig, ...config };
  const evo = createEvolutionClient({ baseUrl: cfg.url, apiKey: cfg.apiKey, fetch: fakeFetch });
  const server = createServer(evo, cfg);
  const client = new Client({ name: 'teste', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  clients.push(client);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content.find((c: any) => c.type === 'text')?.text;
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ...r, data } as { isError?: boolean; content: any[]; data: any };
  };
  return { client, calls, call };
}

describe('lista de ferramentas', () => {
  it('modo write registra leitura, escrita e destrutivas com as anotações certas', async () => {
    const { client } = await setup({});
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(tools).toHaveLength(25);
    expect(byName.evolution_instance_list.annotations?.readOnlyHint).toBe(true);
    expect(byName.evolution_instance_create.annotations?.readOnlyHint).toBe(false);
    expect(byName.evolution_instance_delete.annotations?.destructiveHint).toBe(true);
    expect(byName.evolution_instance_logout.annotations?.destructiveHint).toBe(true);
  });

  it('modo read registra só ferramentas de leitura', async () => {
    const { client } = await setup({}, { mode: 'read' });
    const { tools } = await client.listTools();
    expect(tools.length).toBe(10);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });
});

describe('leitura', () => {
  it('lista instâncias com a chave global e mascara tokens', async () => {
    const { call, calls } = await setup({
      'GET /instance/fetchInstances': {
        body: [{ id: 'i1', name: 'vendas', connectionStatus: 'open', token: 'TOKEN-DA-INSTANCIA', Proxy: { password: 'p' } }],
      },
    });
    const r = await call('evolution_instance_list', { instanceName: 'vendas' });
    expect(r.isError).toBeFalsy();
    expect(r.data[0]).toMatchObject({ name: 'vendas', token: MASK, Proxy: { password: MASK } });
    expect(calls[0].path).toBe('/instance/fetchInstances?instanceName=vendas');
    expect(calls[0].headers.apikey).toBe('chave-global-teste');
  });

  it('mostra segredos quando EVOLUTION_MCP_SHOW_SECRETS está ligado', async () => {
    const { call } = await setup(
      { 'GET /instance/fetchInstances': { body: [{ name: 'vendas', token: 'TOKEN' }] } },
      { showSecrets: true },
    );
    expect((await call('evolution_instance_list')).data[0].token).toBe('TOKEN');
  });

  it('codifica o nome da instância na URL', async () => {
    const { call, calls } = await setup({ 'GET /instance/connectionState/loja%20centro': { body: { instance: { state: 'open' } } } });
    const r = await call('evolution_instance_connection_state', { instanceName: 'loja centro' });
    expect(r.data.instance.state).toBe('open');
    expect(calls[0].path).toBe('/instance/connectionState/loja%20centro');
  });

  it('perfil comercial sem número usa o número da própria instância', async () => {
    const { call, calls } = await setup({
      'GET /instance/fetchInstances': { body: [{ name: 'vendas', ownerJid: '5511988887777@s.whatsapp.net' }] },
      'POST /chat/fetchBusinessProfile/vendas': { body: { description: 'Loja' } },
    });
    await call('evolution_instance_business_profile_get', { instanceName: 'vendas' });
    expect(calls[1].body).toEqual({ number: '5511988887777' });
  });

  it('erro da Evolution vira isError com a mensagem dela', async () => {
    const { call } = await setup({
      'GET /settings/find/x': {
        status: 404,
        body: { status: 404, error: 'Not Found', response: { message: ['The "x" instance does not exist'] } },
      },
    });
    const r = await call('evolution_instance_settings_get', { instanceName: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('The "x" instance does not exist');
  });
});

describe('escrita', () => {
  it('cria instância mapeando proxy e webhook e devolve o QR como imagem', async () => {
    const { call, calls } = await setup({
      'POST /instance/create': {
        status: 201,
        body: {
          instance: { instanceName: 'nova', status: 'connecting' },
          hash: 'TOKEN-GERADO',
          qrcode: { pairingCode: null, code: '2@abc', base64: `data:image/png;base64,${PNG}`, count: 1 },
        },
      },
    });
    const r = await call('evolution_instance_create', {
      instanceName: 'nova',
      rejectCall: true,
      proxy: { host: 'p.local', port: '8080', protocol: 'http' },
      webhook: { url: 'https://hook.test/evo', events: ['MESSAGES_UPSERT'] },
    });
    expect(r.isError).toBeFalsy();
    expect(calls[0].body).toMatchObject({
      instanceName: 'nova',
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      rejectCall: true,
      proxyHost: 'p.local',
      proxyPort: '8080',
      proxyProtocol: 'http',
      webhook: { enabled: true, url: 'https://hook.test/evo', events: ['MESSAGES_UPSERT'] },
    });
    expect(calls[0].body.proxy).toBeUndefined();
    expect(r.data.hash).toBe(MASK);
    expect(r.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: PNG });
  });

  it('connect devolve QR e código de pareamento', async () => {
    const { call, calls } = await setup({
      'GET /instance/connect/vendas': { body: { pairingCode: 'ABCD-1234', code: '2@x', base64: `data:image/png;base64,${PNG}`, count: 1 } },
    });
    const r = await call('evolution_instance_connect', { instanceName: 'vendas', number: '5511999999999' });
    expect(calls[0].path).toBe('/instance/connect/vendas?number=5511999999999');
    expect(r.content.some((c: any) => c.type === 'image')).toBe(true);
    expect(r.content.some((c: any) => c.type === 'text' && c.text.includes('ABCD-1234'))).toBe(true);
  });

  it('a Evolution responder 200 com { error: true } conta como erro', async () => {
    const { call } = await setup({ 'POST /instance/restart/vendas': { body: { error: true, message: 'Error: falhou' } } });
    const r = await call('evolution_instance_restart', { instanceName: 'vendas' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('falhou');
  });

  it('settings_update altera só o campo pedido e mantém os demais', async () => {
    const current = {
      rejectCall: true,
      msgCall: 'Não atendo',
      groupsIgnore: true,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
    };
    const { call, calls } = await setup({
      'GET /settings/find/vendas': { body: current },
      'POST /settings/set/vendas': (c) => ({ status: 201, body: { settings: c.body } }),
    });
    await call('evolution_instance_settings_update', { instanceName: 'vendas', alwaysOnline: true });
    expect(calls[1].body).toEqual({ ...current, alwaysOnline: true });
  });

  it('webhook_set mescla com o atual e usa os nomes do schema de set', async () => {
    const { call, calls } = await setup({
      'GET /webhook/find/vendas': {
        body: { url: 'https://antigo.test', enabled: true, events: ['MESSAGES_UPSERT'], webhookByEvents: true, webhookBase64: false },
      },
      'POST /webhook/set/vendas': { status: 201, body: {} },
    });
    await call('evolution_instance_webhook_set', { instanceName: 'vendas', url: 'https://novo.test' });
    expect(calls[1].body).toEqual({
      webhook: { enabled: true, url: 'https://novo.test', byEvents: true, base64: false, events: ['MESSAGES_UPSERT'] },
    });
  });

  it('webhook_set sem webhook existente exige url', async () => {
    const { call, calls } = await setup({ 'GET /webhook/find/vendas': { body: null } });
    const r = await call('evolution_instance_webhook_set', { instanceName: 'vendas', enabled: false });
    expect(r.isError).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('events_set monta o corpo { <transporte>: { enabled, events } }', async () => {
    const { call, calls } = await setup({ 'POST /rabbitmq/set/vendas': { status: 201, body: {} } });
    await call('evolution_instance_events_set', { instanceName: 'vendas', transport: 'rabbitmq', enabled: true });
    expect(calls[0].body).toEqual({ rabbitmq: { enabled: true, events: [] } });
  });

  it('proxy_set desligado não lê o atual e passa no schema da Evolution', async () => {
    const { call, calls } = await setup({ 'POST /proxy/set/vendas': { status: 201, body: {} } });
    await call('evolution_instance_proxy_set', { instanceName: 'vendas', enabled: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ enabled: false });
    for (const k of ['host', 'port', 'protocol']) expect(calls[0].body[k]).toBeTruthy();
  });

  it('proxy_set ligado completa com o proxy atual (inclusive senha)', async () => {
    const { call, calls } = await setup({
      'GET /proxy/find/vendas': { body: { enabled: false, host: 'p.local', port: '80', protocol: 'http', username: 'u', password: 's' } },
      'POST /proxy/set/vendas': { status: 201, body: {} },
    });
    await call('evolution_instance_proxy_set', { instanceName: 'vendas', enabled: true, port: '8080' });
    expect(calls[1].body).toEqual({ enabled: true, host: 'p.local', port: '8080', protocol: 'http', username: 'u', password: 's' });
  });

  it('privacy_update mescla com a privacidade atual', async () => {
    const current = { readreceipts: 'all', profile: 'all', status: 'contacts', online: 'all', last: 'contacts', groupadd: 'all' };
    const { call, calls } = await setup({
      'GET /chat/fetchPrivacySettings/vendas': { body: current },
      'POST /chat/updatePrivacySettings/vendas': { status: 201, body: {} },
    });
    await call('evolution_instance_privacy_update', { instanceName: 'vendas', groupadd: 'contacts' });
    expect(calls[1].body).toEqual({ ...current, groupadd: 'contacts' });
  });
});

describe('destrutivas', () => {
  it('delete sem confirmação igual ao nome não chama a Evolution', async () => {
    const { call, calls } = await setup({});
    const r = await call('evolution_instance_delete', { instanceName: 'vendas', confirm: 'Vendas' });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('delete com confirmação chama DELETE /instance/delete', async () => {
    const { call, calls } = await setup({
      'DELETE /instance/delete/vendas': { body: { status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } } },
    });
    const r = await call('evolution_instance_delete', { instanceName: 'vendas', confirm: 'vendas' });
    expect(r.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/instance/delete/vendas' });
  });

  it('instância protegida não é desconectada nem apagada', async () => {
    const { call, calls } = await setup({}, { protectedInstances: ['producao'] });
    for (const tool of ['evolution_instance_logout', 'evolution_instance_delete']) {
      const r = await call(tool, { instanceName: 'producao', confirm: 'producao' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('protegida');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('config', () => {
  it('exige URL e chave', () => {
    expect(() => loadConfig({})).toThrow(/EVOLUTION_URL[\s\S]*EVOLUTION_API_KEY/);
  });

  it('lê modo, protegidas e segredos', () => {
    const c = loadConfig({
      EVOLUTION_URL: 'https://evo.test',
      EVOLUTION_API_KEY: 'k',
      EVOLUTION_MCP_MODE: 'read',
      EVOLUTION_MCP_PROTECTED_INSTANCES: 'a, b ,',
      EVOLUTION_MCP_SHOW_SECRETS: 'true',
    });
    expect(c).toMatchObject({ mode: 'read', protectedInstances: ['a', 'b'], showSecrets: true, timeoutMs: 30000 });
  });
});
