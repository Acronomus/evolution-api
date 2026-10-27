import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Vitest, e não Jest: a baileys 7 é ESM puro (e a whatsapp-rust-bridge que ela usa só
// exporta `import`). O Jest não carrega isso a partir do código CommonJS do app sem
// transformar node_modules; o Vitest deixa o Node carregar a baileys como está.
const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const alias = {
  '@api': dir('./src/api'),
  '@cache': dir('./src/cache'),
  '@config': dir('./src/config'),
  '@exceptions': dir('./src/exceptions'),
  '@libs': dir('./src/libs'),
  '@utils': dir('./src/utils'),
  '@validate': dir('./src/validate'),
  '@tests': dir('./tests'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup.ts'],
          testTimeout: 15_000,
        },
      },
      {
        // Postgres e Redis reais em containers (Testcontainers), baileys trocada por um
        // socket falso e rede cortada (tests/integration/setup.ts).
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/integration/globalSetup.ts'],
          setupFiles: ['tests/setup.ts', 'tests/integration/setup.ts'],
          // Um banco só, arquivos em sequência: o app guarda as instâncias num
          // singleton (waMonitor) e o banco é zerado entre os testes.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
