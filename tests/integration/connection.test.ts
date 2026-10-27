/**
 * Fechamento de conexão (connectionUpdate) com o socket falso da baileys.
 * Correção do build próprio (4bda3105): um `loggedOut` logo depois de um
 * `stream:error` 515 é o restart do WhatsApp, não um logout; a instância reconecta
 * em vez de ser despareada (cleaningUp apagaria a sessão e exigiria QR de novo).
 */
import { prismaRepository, waMonitor } from '@api/server.module';
import { Boom } from '@hapi/boom';
import { DisconnectReason } from 'baileys';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDb, settle } from './helpers/db';
import { sockets } from './helpers/fakeBaileys';
import { connectOpen, createInstance, waitForState } from './helpers/instances';

beforeEach(resetDb);

const loggedOut = () => new Boom('Connection Failure', { statusCode: DisconnectReason.loggedOut });

describe('connection.update com connection=close', () => {
  it('loggedOut logo depois de stream:error 515 reconecta sem apagar a sessão', async () => {
    await createInstance('loja-a');
    const first = await connectOpen('loja-a');
    const instanceId = waMonitor.waInstances['loja-a'].instanceId;
    const sessionBefore = await prismaRepository.session.findFirst({ where: { sessionId: instanceId } });
    expect(sessionBefore).not.toBeNull();

    first.receiveNode('CB:stream:error', { tag: 'stream:error', attrs: { code: '515' } });
    await first.end(loggedOut());

    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 5000 });
    await settle('loja-a');
    expect(waMonitor.waInstances['loja-a']).toBeDefined();
    expect(await prismaRepository.session.findFirst({ where: { sessionId: instanceId } })).not.toBeNull();
  });

  it('loggedOut sem 515 antes é logout de verdade: não reconecta e marca a instância como fechada', async () => {
    await createInstance('loja-a');
    const first = await connectOpen('loja-a');

    await first.end(loggedOut());
    await waitForState('loja-a', 'close');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(sockets).toHaveLength(1);
    const row = await prismaRepository.instance.findUnique({ where: { name: 'loja-a' } });
    expect(row?.connectionStatus).toBe('close');
  });

  it('queda comum (sem statusCode de logout) reconecta', async () => {
    await createInstance('loja-a');
    const first = await connectOpen('loja-a');

    await first.end(new Boom('Connection Lost', { statusCode: DisconnectReason.connectionLost }));

    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 5000 });
  });
});
