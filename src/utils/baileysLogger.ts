import type { Log, LogBaileys } from '@config/env.config';
import P from 'pino';

/**
 * Nível do log da baileys para uma instância. `LOG_BAILEYS` vale para todas; as instâncias em
 * `LOG_BAILEYS_INSTANCES` usam `LOG_BAILEYS_INSTANCES_LEVEL` (debug por padrão). Serve para
 * depurar uma conexão em produção sem lotar o log com as outras.
 */
export function baileysLogLevel(log: Log, instanceName: string): LogBaileys {
  return log.BAILEYS_INSTANCES.includes(instanceName) ? log.BAILEYS_INSTANCES_LEVEL : log.BAILEYS;
}

/**
 * Logger da baileys com `instance: "[nome]"` em toda linha: o filtro por instância do `GET /logs`
 * (e do `evolution_logs` do MCP) procura `[nome]` no texto, e as linhas JSON da baileys não o traziam.
 */
export function baileysLogger(log: Log, instanceName: string) {
  return P({ level: baileysLogLevel(log, instanceName) }, process.stdout).child({ instance: `[${instanceName}]` });
}
