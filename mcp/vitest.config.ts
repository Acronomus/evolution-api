import { defineConfig } from 'vitest/config';

// Config própria: sem ela o Vitest sobe até o vitest.config.mts do app da Evolution.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
