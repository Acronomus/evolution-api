/**
 * Sobe o Postgres e o Redis da suíte de integração, uma vez por execução.
 *
 * - Postgres na versão do docker-compose do repo (15), dados em tmpfs: nada sobra
 *   no disco e o container some no fim. TEST_PG_IMAGE troca a imagem.
 * - O app conecta com um role comum, dono do banco, sem SUPERUSER nem BYPASSRLS.
 * - O banco nasce só das migrations (prisma/postgresql-migrations), aplicadas com
 *   `prisma migrate deploy`, como o Docker/scripts/deploy_database.sh faz no deploy.
 * - Um banco vazio extra serve de shadow para o `migrate diff` do schema.test.ts.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

export const PG_IMAGE = process.env.TEST_PG_IMAGE ?? 'postgres:15-alpine';
export const REDIS_IMAGE = process.env.TEST_REDIS_IMAGE ?? 'redis:7-alpine';
const APP_ROLE = 'evolution_app';
const APP_PASSWORD = 'evolution_app';
const APP_DB = 'evolution_test';
const SHADOW_DB = 'evolution_shadow';

const ROOT = path.resolve(__dirname, '../..');

/**
 * O Prisma procura as migrations em `<pasta do schema>/migrations`. O repo guarda
 * em `prisma/postgresql-migrations` e o `db:deploy` copia para `prisma/migrations`;
 * aqui a cópia vai para uma pasta temporária, sem mexer no checkout.
 */
export const preparePrismaDir = (): string => {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'evolution-prisma-'));
  fs.copyFileSync(path.join(ROOT, 'prisma/postgresql-schema.prisma'), path.join(dir, 'schema.prisma'));
  fs.cpSync(path.join(ROOT, 'prisma/postgresql-migrations'), path.join(dir, 'migrations'), { recursive: true });
  return dir;
};

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    shadowDatabaseUrl: string;
    redisUrl: string;
    prismaDir: string;
  }
}

export default async function globalSetup(project: TestProject) {
  fs.rmSync(path.join(ROOT, '.route-coverage'), { recursive: true, force: true });

  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer(PG_IMAGE)
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .withCommand(['postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off'])
      .start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);

  const psql = async (sql: string): Promise<void> => {
    const res = await pg.exec(['psql', '-v', 'ON_ERROR_STOP=1', '-U', pg.getUsername(), '-d', 'postgres', '-c', sql]);
    if (res.exitCode !== 0) throw new Error(`psql falhou: ${sql}\n${res.output}`);
  };

  await psql(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB`);
  await psql(`CREATE DATABASE ${APP_DB} OWNER ${APP_ROLE}`);
  await psql(`CREATE DATABASE ${SHADOW_DB}`);

  const host = pg.getHost();
  const port = pg.getPort();
  const databaseUrl = `postgresql://${APP_ROLE}:${APP_PASSWORD}@${host}:${port}/${APP_DB}`;
  const prismaDir = preparePrismaDir();

  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', path.join(prismaDir, 'schema.prisma')], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_CONNECTION_URI: databaseUrl },
    stdio: 'pipe',
  });

  project.provide('databaseUrl', databaseUrl);
  project.provide(
    'shadowDatabaseUrl',
    `postgresql://${pg.getUsername()}:${pg.getPassword()}@${host}:${port}/${SHADOW_DB}`,
  );
  project.provide('redisUrl', redis.getConnectionUrl());
  project.provide('prismaDir', prismaDir);

  return async () => {
    await Promise.all([pg.stop(), redis.stop()]);
    fs.rmSync(prismaDir, { recursive: true, force: true });
  };
}
