/**
 * Roda depois de tests/setup.ts, em cada arquivo de integração, antes do import do app.
 *
 * - Aponta o app para o Postgres e o Redis dos containers (globalSetup.ts).
 * - Corta a rede: o nock recusa HTTP/fetch para fora da máquina e todo socket TCP
 *   para fora do host dos containers falha. Provedor sem resposta preparada no
 *   teste quebra o teste em vez de sair para a internet.
 * - Troca o `makeWASocket` da baileys pelo socket falso (helpers/fakeBaileys.ts).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';

import nock from 'nock';
import { afterAll, afterEach, beforeEach, inject, vi } from 'vitest';

const databaseUrl = inject('databaseUrl');
const containerHost = new URL(databaseUrl).hostname;

process.env.DATABASE_CONNECTION_URI = databaseUrl;
process.env.CACHE_REDIS_ENABLED = 'true';
process.env.CACHE_REDIS_URI = inject('redisUrl');
process.env.CACHE_LOCAL_ENABLED = 'false';

vi.mock('baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('baileys')>();
  const fake = await import('./helpers/fakeBaileys');
  fake.useRealEventBuffer(actual.makeEventBuffer as any);
  return { ...actual, default: fake.makeFakeSocket, makeWASocket: fake.makeFakeSocket };
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', containerHost]);
const isLocal = (host: string) => LOCAL_HOSTS.has(host.replace(/^\[|\]$/g, ''));

nock.disableNetConnect();
nock.enableNetConnect((host) => isLocal(host.replace(/:\d+$/, '')));

// Pega o que não passa pelo módulo http (websocket da baileys, clientes TCP).
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
  // net.connect() chama socket.connect() com os argumentos já normalizados num array.
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof first === 'object' && first !== null ? first : { port: first, host: second };
  if (!options.path) {
    const host = String(options.host ?? 'localhost');
    if (!isLocal(host)) {
      throw new Error(`Rede cortada nos testes: conexão para ${host}:${options.port} bloqueada`);
    }
  }
  return (originalConnect as any).apply(this, args);
} as typeof net.Socket.prototype.connect;

/**
 * Registra cada rota que um teste atingiu (método + padrão, ex.:
 * POST /message/sendText/:instanceName) para o scripts/check-route-coverage.mjs.
 * Precisa vir antes do import do app: o Express guarda `route.dispatch.bind(route)`
 * ao criar a rota, então um patch posterior não pegaria as rotas já criadas.
 * Grava na hora em que o Express escolhe a rota, quando req.baseUrl ainda é o do router.
 */
const ROUTE_HITS_DIR = path.resolve(__dirname, '../../.route-coverage');
const Route = createRequire(__filename)('express/lib/router/route');
if (!Route.prototype.__routeCoverage) {
  const dispatch = Route.prototype.dispatch;
  Route.prototype.dispatch = function (
    this: { path: string },
    req: { method: string; baseUrl: string },
    ...rest: unknown[]
  ) {
    fs.mkdirSync(ROUTE_HITS_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(ROUTE_HITS_DIR, `hits-${process.pid}.txt`),
      `${req.method.toUpperCase()} ${req.baseUrl}${this.path}\n`,
    );
    return dispatch.call(this, req, ...rest);
  };
  Route.prototype.__routeCoverage = true;
}

beforeEach(async () => {
  const { sockets } = await import('./helpers/fakeBaileys');
  sockets.length = 0;
});

afterEach(() => {
  const pending = nock.pendingMocks();
  nock.cleanAll();
  if (pending.length) throw new Error(`Respostas preparadas que não foram usadas:\n${pending.join('\n')}`);
});

afterAll(async () => {
  const { resetApp } = await import('./helpers/app');
  await resetApp();
});
