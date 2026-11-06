import * as z from 'zod/v4';

const bool = z
  .string()
  .optional()
  .transform((v) => ['1', 'true', 'yes', 'sim'].includes((v ?? '').trim().toLowerCase()));

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  EVOLUTION_URL: z.url({ message: 'EVOLUTION_URL precisa ser a URL base da Evolution (ex.: https://evo.exemplo.com)' }),
  EVOLUTION_API_KEY: z.string().min(1, 'EVOLUTION_API_KEY (chave global da Evolution) é obrigatória'),
  /** `read` registra só as ferramentas de leitura. */
  EVOLUTION_MCP_MODE: z.enum(['read', 'write']).default('write'),
  /** Instâncias que o MCP se recusa a desconectar ou apagar (separadas por vírgula). */
  EVOLUTION_MCP_PROTECTED_INSTANCES: list,
  /** Por padrão tokens, senhas e chaves saem mascarados nas respostas. */
  EVOLUTION_MCP_SHOW_SECRETS: bool,
  EVOLUTION_MCP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export interface Config {
  url: string;
  apiKey: string;
  mode: 'read' | 'write';
  protectedInstances: string[];
  showSecrets: boolean;
  timeoutMs: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida do evolution-mcp:\n${issues}`);
  }
  const e = parsed.data;
  return {
    url: e.EVOLUTION_URL,
    apiKey: e.EVOLUTION_API_KEY,
    mode: e.EVOLUTION_MCP_MODE,
    protectedInstances: e.EVOLUTION_MCP_PROTECTED_INSTANCES,
    showSecrets: e.EVOLUTION_MCP_SHOW_SECRETS,
    timeoutMs: e.EVOLUTION_MCP_TIMEOUT_MS,
  };
}
