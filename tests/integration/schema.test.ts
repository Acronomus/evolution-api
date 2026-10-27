/**
 * O schema.prisma e as migrations precisam descrever o mesmo banco. Se divergirem,
 * a próxima `db:migrate:dev` gera uma migration com mudanças inesperadas (ex.: DROP
 * de algo que existe em produção). O banco dos testes já nasceu só das migrations
 * (globalSetup.ts); aqui a comparação é com o schema.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { expect, inject, it } from 'vitest';

it('prisma/postgresql-schema.prisma bate com prisma/postgresql-migrations', () => {
  const prismaDir = inject('prismaDir');
  const res = spawnSync(
    'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-migrations',
      path.join(prismaDir, 'migrations'),
      '--to-schema-datamodel',
      path.join(prismaDir, 'schema.prisma'),
      '--shadow-database-url',
      inject('shadowDatabaseUrl'),
      '--script',
      '--exit-code',
    ],
    { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' },
  );
  // --exit-code: 0 = sem diferença, 2 = há diferença (o SQL vai para stdout).
  expect(res.status, `Falta migration para o schema:\n${res.stdout}${res.stderr}`).toBe(0);
});
