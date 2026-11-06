/**
 * Servidor MCP (Model Context Protocol) em /mcp — build próprio da Acronomus.
 *
 * Streamable HTTP sem sessão: cada requisição monta um servidor com as ferramentas de
 * instância (mcp.tools.ts), e cada ferramenta chama a própria API REST por loopback com a
 * apikey de quem chamou. Quem decide o que a chave pode fazer são os guards da API: a
 * chave global vê e cria instâncias; o token de uma instância só passa nas rotas dela.
 *
 * Autenticação: header `apikey` (igual à API) ou `Authorization: Bearer <apikey>`.
 * Desligado por padrão (MCP_ENABLED).
 */
import { prismaRepository } from '@api/server.module';
import { Auth, configService, Mcp } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { Router } from 'express';
import type { TLSSocket } from 'tls';

import { createLoopbackClient } from './mcp.client';
import { createMcpServer } from './mcp.tools';

const logger = new Logger('MCP');

export const MCP_PATH = '/mcp';

/** A apikey do pedido: header `apikey` ou `Authorization: Bearer`. */
export function requestKey(req: Request): string | undefined {
  const header = req.get('apikey')?.trim();
  if (header) return header;
  const auth = req.get('authorization')?.trim();
  const m = auth && /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : undefined;
}

function unauthorized(res: Response, message: string) {
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer realm="evolution-mcp"')
    .json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

export function createMcpRouter(): Router {
  const router = Router();

  const handler = createMcpHandler(
    ({ authInfo }) => {
      const mcp = configService.get<Mcp>('MCP');
      const target = authInfo!.extra!.target as { port: number; tls: boolean };
      return createMcpServer(createLoopbackClient(target, authInfo!.token), {
        readOnly: mcp.READ_ONLY,
        protectedInstances: mcp.PROTECTED_INSTANCES,
        showSecrets: mcp.SHOW_SECRETS,
        globalKey: authInfo!.extra?.globalKey === true,
      });
    },
    {
      responseMode: 'json',
      onerror: (err) => logger.error(`MCP: ${err.message}`),
    },
  );
  const serve = toNodeHandler(handler, { onerror: (err) => logger.error(`MCP: ${err.message}`) });

  const endpoint = async (req: Request, res: Response) => {
    if (!configService.get<Mcp>('MCP').ENABLED) {
      res.status(404).json({ status: 404, error: 'Not Found', response: { message: ['MCP desligado (MCP_ENABLED)'] } });
      return;
    }

    const key = requestKey(req);
    if (!key) return unauthorized(res, 'Envie a apikey no header `apikey` ou em `Authorization: Bearer`');

    const globalKey = key === configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
    let clientId = 'global';
    if (!globalKey) {
      const instance = await prismaRepository.instance
        .findFirst({ where: { token: key }, select: { name: true } })
        .catch(() => null);
      if (!instance) return unauthorized(res, 'apikey inválida');
      clientId = `instance:${instance.name}`;
    }

    const target = { port: req.socket.localPort!, tls: Boolean((req.socket as TLSSocket).encrypted) };
    (req as any).auth = { token: key, clientId, scopes: [], extra: { globalKey, target } };
    try {
      await serve(req as any, res as any, req.body);
    } catch (err) {
      logger.error(`MCP: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent)
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno' }, id: null });
    }
  };

  router.post(MCP_PATH, endpoint).get(MCP_PATH, endpoint).delete(MCP_PATH, endpoint);
  return router;
}
