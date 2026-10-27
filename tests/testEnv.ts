/**
 * Variáveis de ambiente dos testes.
 *
 * O `configService` (src/config/env.config.ts) lê o process.env uma vez, na
 * importação. Então tudo aqui precisa estar aplicado antes de qualquer import do
 * app, e nenhum valor real pode entrar:
 *
 * - tests/setup.ts troca o `dotenv` por um que não lê nada (um `.env` de verdade
 *   na pasta nunca chega aos testes);
 * - `applyTestEnv()` apaga do process.env toda variável que o env.config lê e
 *   que não está fixada abaixo (o shell de quem roda também não vaza).
 *
 * Integrações externas ficam desligadas. A telemetria vem LIGADA por padrão no
 * Evolution (manda cada rota para log.evolution-api.com): aqui é desligada.
 */
import fs from 'node:fs';
import path from 'node:path';

export const TEST_API_KEY = 'test-global-api-key';

export const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  SERVER_TYPE: 'http',
  SERVER_PORT: '8080',
  SERVER_URL: 'http://localhost:8080',
  SERVER_DISABLE_MANAGER: 'false',
  CORS_ORIGIN: '*',
  CORS_METHODS: 'GET,POST,PUT,DELETE',
  CORS_CREDENTIALS: 'true',

  LOG_LEVEL: 'ERROR',
  LOG_COLOR: 'false',
  LOG_BAILEYS: 'silent',
  LANGUAGE: 'en',

  AUTHENTICATION_API_KEY: TEST_API_KEY,
  AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES: 'false',
  DEL_INSTANCE: 'false',
  TELEMETRY_ENABLED: 'false',
  PROMETHEUS_METRICS: 'false',
  SENTRY_DSN: '',

  // Endereço obviamente falso: o setup de integração troca pelo banco do container.
  DATABASE_PROVIDER: 'postgresql',
  DATABASE_CONNECTION_URI: 'postgresql://test:test@127.0.0.1:59999/evolution_test',
  DATABASE_CONNECTION_CLIENT_NAME: 'evolution_test',
  DATABASE_SAVE_DATA_INSTANCE: 'true',
  DATABASE_SAVE_DATA_NEW_MESSAGE: 'true',
  DATABASE_SAVE_MESSAGE_UPDATE: 'true',
  DATABASE_SAVE_DATA_CONTACTS: 'true',
  DATABASE_SAVE_DATA_CHATS: 'true',
  DATABASE_SAVE_DATA_LABELS: 'true',
  DATABASE_SAVE_DATA_HISTORIC: 'true',
  DATABASE_SAVE_IS_ON_WHATSAPP: 'true',
  DATABASE_SAVE_IS_ON_WHATSAPP_DAYS: '7',
  DATABASE_DELETE_MESSAGE: 'true',

  CACHE_REDIS_ENABLED: 'false',
  CACHE_REDIS_URI: '',
  CACHE_REDIS_PREFIX_KEY: 'evolution_test',
  CACHE_REDIS_SAVE_INSTANCES: 'false',
  CACHE_LOCAL_ENABLED: 'true',

  CONFIG_SESSION_PHONE_CLIENT: 'Evolution API',
  CONFIG_SESSION_PHONE_NAME: 'Chrome',
  QRCODE_LIMIT: '30',
  QRCODE_COLOR: '#175197',

  WEBHOOK_GLOBAL_ENABLED: 'false',
  WEBHOOK_EVENTS_ERRORS: 'false',
  WEBHOOK_RETRY_MAX_ATTEMPTS: '1',
  WEBHOOK_REQUEST_TIMEOUT_MS: '5000',
  WEBSOCKET_ENABLED: 'false',
  RABBITMQ_ENABLED: 'false',
  NATS_ENABLED: 'false',
  SQS_ENABLED: 'false',
  KAFKA_ENABLED: 'false',
  PUSHER_ENABLED: 'false',
  S3_ENABLED: 'false',
  PROVIDER_ENABLED: 'false',
  CHATWOOT_ENABLED: 'false',
  OPENAI_ENABLED: 'false',
  DIFY_ENABLED: 'false',
  TYPEBOT_ENABLED: 'false',
  FLOWISE_ENABLED: 'false',
  N8N_ENABLED: 'false',
  EVOAI_ENABLED: 'false',
};

/** Nomes de todas as variáveis que o env.config lê. */
const configuredNames = (): string[] => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/config/env.config.ts'), 'utf8');
  return [...new Set([...source.matchAll(/process\.env\??\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
};

export const applyTestEnv = (): void => {
  for (const name of configuredNames()) {
    if (!(name in testEnv)) delete process.env[name];
  }
  Object.assign(process.env, testEnv);
};
