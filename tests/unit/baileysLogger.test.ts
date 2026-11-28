/**
 * Nível do log da baileys por instância (src/utils/baileysLogger.ts): LOG_BAILEYS_INSTANCES liga
 * um nível mais detalhado só nas instâncias listadas.
 */
import type { Log } from '@config/env.config';
import { baileysLogger, baileysLogLevel } from '@utils/baileysLogger';
import { describe, expect, it } from 'vitest';

const log = (over: Partial<Log> = {}): Log => ({
  LEVEL: [],
  COLOR: false,
  BAILEYS: 'error',
  BAILEYS_INSTANCES: [],
  BAILEYS_INSTANCES_LEVEL: 'debug',
  ...over,
});

describe('baileysLogLevel', () => {
  it('usa LOG_BAILEYS quando a instância não está na lista', () => {
    expect(baileysLogLevel(log(), 'liga-metal-santos-ltda_72')).toBe('error');
    expect(baileysLogLevel(log({ BAILEYS_INSTANCES: ['outra_1'] }), 'liga-metal-santos-ltda_72')).toBe('error');
  });

  it('usa o nível detalhado só para as instâncias listadas', () => {
    const l = log({ BAILEYS_INSTANCES: ['liga-metal-santos-ltda_72', 'massfix_8'], BAILEYS_INSTANCES_LEVEL: 'trace' });
    expect(baileysLogLevel(l, 'liga-metal-santos-ltda_72')).toBe('trace');
    expect(baileysLogLevel(l, 'massfix_8')).toBe('trace');
    expect(baileysLogLevel(l, 'cts-comercio-de-aparas-ltda_55')).toBe('error');
  });
});

describe('baileysLogger', () => {
  it('aplica o nível e marca a instância como [nome] para o filtro do GET /logs', () => {
    const logger = baileysLogger(log({ BAILEYS_INSTANCES: ['liga-metal-santos-ltda_72'] }), 'liga-metal-santos-ltda_72');
    expect(logger.level).toBe('debug');
    expect(logger.bindings()).toEqual({ instance: '[liga-metal-santos-ltda_72]' });
    expect(baileysLogger(log(), 'massfix_8').level).toBe('error');
  });
});
