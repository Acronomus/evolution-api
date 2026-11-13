/**
 * `GET /logs` (build próprio da Acronomus): consulta o buffer de stdout/stderr, como um
 * `docker logs --tail N --since X | grep`. Só a chave global. É a rota que a ferramenta
 * `evolution_logs` do MCP chama por loopback.
 *
 * Query: `tail` (padrão 200, sem máximo), `since` (ISO ou 30s/10m/2h/1d), `grep`, `regex=true`,
 * `instance`, `level` (ERROR,WARN...), `stream` (stdout|stderr).
 */
import { requestKey } from '@api/mcp/mcp.router';
import { Auth, configService } from '@config/env.config';
import type { Request, Response } from 'express';
import { Router } from 'express';

import { LEVELS, logBuffer, LogQuery, parseSince } from './log.buffer';

export const LOGS_PATH = '/logs';

const fail = (res: Response, status: number, error: string, message: string) =>
  res.status(status).json({ status, error, response: { message: [message] } });

const one = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;

export function createLogsRouter(): Router {
  const router = Router();

  router.get(LOGS_PATH, (req: Request, res: Response) => {
    const key = requestKey(req);
    if (!key) return fail(res, 401, 'Unauthorized', 'Envie a apikey global');
    if (key !== configService.get<Auth>('AUTHENTICATION').API_KEY.KEY)
      return fail(res, 403, 'Forbidden', 'Os logs são do servidor inteiro: só a chave global consulta');

    const buffer = logBuffer();
    if (!buffer) return fail(res, 503, 'Service Unavailable', 'Captura de logs não instalada');

    const q: LogQuery = {};
    try {
      const tail = one(req.query.tail);
      if (tail !== undefined) {
        q.tail = Number(tail);
        if (!Number.isFinite(q.tail) || q.tail < 1) throw new Error(`tail inválido: "${tail}"`);
      }
      const since = one(req.query.since);
      if (since) q.since = parseSince(since);
      q.grep = one(req.query.grep) || undefined;
      q.regex = one(req.query.regex) === 'true';
      q.instance = one(req.query.instance) || undefined;
      const level = one(req.query.level);
      if (level) {
        q.levels = level
          .split(',')
          .map((l) => l.trim().toUpperCase())
          .filter(Boolean);
        const bad = q.levels.filter((l) => !(LEVELS as readonly string[]).includes(l));
        if (bad.length) throw new Error(`level inválido: ${bad.join(', ')} (use ${LEVELS.join(', ')})`);
      }
      const stream = one(req.query.stream);
      if (stream) {
        if (stream !== 'stdout' && stream !== 'stderr') throw new Error(`stream inválido: "${stream}"`);
        q.stream = stream;
      }
      const result = buffer.query(q);
      return res.status(200).json({
        ...result,
        oldest: result.oldest === null ? null : new Date(result.oldest).toISOString(),
        lines: result.lines.map((l) => ({ ...l, time: new Date(l.time).toISOString() })),
      });
    } catch (err) {
      return fail(res, 400, 'Bad Request', (err as Error).message);
    }
  });

  return router;
}
