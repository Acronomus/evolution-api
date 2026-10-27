import { prismaRepository, waMonitor } from '@api/server.module';
import { redisClient } from '@cache/rediscache.client';

/** Esvazia o banco (menos o histórico de migrations), o Redis e as instâncias em memória. */
export const resetDb = async (): Promise<void> => {
  for (const name of Object.keys(waMonitor.waInstances)) {
    waMonitor.waInstances[name].endSession = true;
    delete waMonitor.waInstances[name];
  }

  const rows = await prismaRepository.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (rows.length) {
    const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
    await prismaRepository.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }

  const redis = redisClient.getConnection();
  if (redis) {
    if (!redis.isReady) await new Promise((resolve) => redis.once('ready', resolve));
    await redis.flushDb();
  }
};

/**
 * O app processa os eventos da baileys numa fila própria (eventProcessingQueue).
 * Espera a fila da instância esvaziar, inclusive o que cada evento enfileirar.
 */
export const settle = async (instanceName: string): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    const instance = waMonitor.waInstances[instanceName];
    if (!instance) return;
    const queue = instance.eventProcessingQueue;
    await queue;
    await new Promise((resolve) => setImmediate(resolve));
    if (instance.eventProcessingQueue === queue) return;
  }
};
