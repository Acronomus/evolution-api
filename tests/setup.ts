/**
 * Roda antes de cada arquivo de teste (unidade e integração), antes de qualquer
 * import do app.
 */
import { vi } from 'vitest';

import { applyTestEnv } from './testEnv';

// O env.config chama dotenv.config() na importação: sem isto um `.env` real na
// raiz do repo entraria nos testes.
vi.mock('dotenv', () => {
  const config = () => ({ parsed: {} });
  return { default: { config }, config };
});

applyTestEnv();
