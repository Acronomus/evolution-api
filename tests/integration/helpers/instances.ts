import { waMonitor } from '@api/server.module';
import { expect, vi } from 'vitest';

import { api, GLOBAL_KEY } from './app';
import { FakeSocket, sockets } from './fakeBaileys';

/** Cria uma instância Baileys pela rota, sem conectar. Devolve o token dela. */
export const createInstance = async (instanceName: string, extra: Record<string, unknown> = {}) => {
  const res = await (
    await api()
  )
    .post('/instance/create')
    .set(GLOBAL_KEY)
    .send({ instanceName, integration: 'WHATSAPP-BAILEYS', ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { token: res.body.hash as string, body: res.body };
};

/**
 * O app não aguarda o `connectionUpdate` dentro da fila de eventos: o estado muda
 * depois. Espera até chegar no estado pedido.
 */
export const waitForState = (instanceName: string, state: string) =>
  vi.waitFor(() => expect(waMonitor.waInstances[instanceName]?.connectionStatus?.state).toBe(state), {
    timeout: 5000,
    interval: 20,
  });

export const lastSocket = (): FakeSocket => {
  expect(sockets.length).toBeGreaterThan(0);
  return sockets[sockets.length - 1];
};

/**
 * Conecta e faz o socket falso mostrar um QR: estado `connecting`.
 * `viaRoute` usa GET /instance/connect (que espera 2 s); senão chama o serviço direto.
 */
export const connectWithQr = async (instanceName: string, { viaRoute = false } = {}): Promise<FakeSocket> => {
  if (viaRoute) {
    const res = await (await api()).get(`/instance/connect/${instanceName}`).set(GLOBAL_KEY);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  } else {
    await waMonitor.waInstances[instanceName].connectToWhatsapp();
  }
  const socket = lastSocket();
  // A baileys emite `connecting` ao abrir o socket e depois o QR.
  socket.ev.emit('connection.update', { connection: 'connecting', qr: `2@fake-qr-${instanceName}` });
  await waitForState(instanceName, 'connecting');
  return socket;
};

/** Conecta e simula o QR lido: estado `open`. */
export const connectOpen = async (instanceName: string): Promise<FakeSocket> => {
  const socket = await connectWithQr(instanceName);
  socket.open();
  await waitForState(instanceName, 'open');
  return socket;
};
