import fs from 'node:fs';
import path from 'node:path';

import type { Express } from 'express';
import request from 'supertest';

import { TEST_API_KEY } from '../../testEnv';

/** Rotas atingidas (registradas em tests/integration/setup.ts) e lista de rotas do app. */
export const ROUTE_HITS_DIR = path.resolve(__dirname, '../../../.route-coverage');

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  name?: string;
  regexp?: RegExp & { fast_slash?: boolean };
  handle?: { stack?: Layer[] };
}

// Express 4 guarda o caminho de montagem só como regex: /^\/instance\/?(?=\/|$)/i
const mountPath = (layer: Layer): string =>
  !layer.regexp || layer.regexp.fast_slash
    ? ''
    : layer.regexp.source
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\\\//g, '/');

/** Todas as rotas do app, no mesmo formato que o registro de rotas atingidas. */
export const listRoutes = (stack: Layer[], base = ''): string[] =>
  stack.flatMap((layer) => {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods).filter((m) => m !== '_all');
      return paths.flatMap((p) => methods.map((m) => `${m.toUpperCase()} ${base}${p}`));
    }
    if (layer.name === 'router' && layer.handle?.stack) return listRoutes(layer.handle.stack, base + mountPath(layer));
    return [];
  });

let app: Express | undefined;

const buildApp = async (): Promise<Express> => {
  if (!app) {
    const { createApp } = await import('../../../src/app');
    app = createApp();
    // Lista de rotas para o scripts/check-route-coverage.mjs (que não carrega o app).
    const routes = [...new Set(listRoutes((app as any)._router.stack))].sort();
    fs.mkdirSync(ROUTE_HITS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ROUTE_HITS_DIR, 'routes.txt'), routes.join('\n') + '\n');
  }
  return app;
};

export const api = async () => request(await buildApp());

export const GLOBAL_KEY = { apikey: TEST_API_KEY };

/** Fecha conexões e encerra as instâncias em memória no fim de cada arquivo. */
export const resetApp = async (): Promise<void> => {
  const { waMonitor, prismaRepository } = await import('@api/server.module');
  for (const name of Object.keys(waMonitor.waInstances)) {
    const instance = waMonitor.waInstances[name];
    instance.endSession = true;
    delete waMonitor.waInstances[name];
  }
  await prismaRepository.$disconnect();
  const { redisClient } = await import('@cache/rediscache.client');
  const client = (redisClient as any).client;
  if (client?.isOpen) await client.quit();
};
