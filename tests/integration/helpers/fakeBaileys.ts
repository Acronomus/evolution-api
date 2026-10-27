/**
 * Socket falso da baileys: substitui o `makeWASocket` nos testes de integração
 * (tests/integration/setup.ts). Nada sai para o WhatsApp.
 *
 * O `ev` é o event buffer DE VERDADE da baileys (`makeEventBuffer`), então
 * `ev.process`, `ev.emit` e `ev.removeAllListeners` se comportam como em produção.
 * O `end()` imita o da baileys (lib/Socket/socket.js): fecha uma vez só e emite
 * `connection.update` com `connection: 'close'` e o erro recebido.
 *
 * Os métodos que o app chama são `vi.fn()` com respostas mínimas; cada teste
 * ajusta o que precisa (ex.: `socket.onWhatsApp.mockResolvedValue(...)`).
 */
import { EventEmitter } from 'node:events';

import type { UserFacingSocketConfig } from 'baileys';
import P from 'pino';
import { vi } from 'vitest';

type EventBuffer = {
  process(handler: (events: Record<string, any>) => Promise<void> | void): () => void;
  emit(event: string, data: unknown): boolean;
  removeAllListeners(event?: string): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
};

let makeEventBuffer: (logger: unknown) => EventBuffer;

/** Chamado pelo vi.mock com o módulo real da baileys. */
export const useRealEventBuffer = (fn: typeof makeEventBuffer): void => {
  makeEventBuffer = fn;
};

/** Todos os sockets criados no arquivo de teste atual, em ordem. */
export const sockets: FakeSocket[] = [];

let messageSeq = 0;

export class FakeSocket {
  readonly ev: EventBuffer = makeEventBuffer(P({ level: 'silent' }));
  readonly ws = Object.assign(new EventEmitter(), {
    isOpen: true,
    isClosed: false,
    isClosing: false,
    close: vi.fn(async () => {
      this.ws.isOpen = false;
      this.ws.isClosed = true;
    }),
  });
  closed = false;
  user: { id: string; name?: string; lid?: string } | undefined;
  readonly authState: UserFacingSocketConfig['auth'];

  readonly end = vi.fn(async (error?: Error) => {
    if (this.closed) return;
    this.closed = true;
    await this.ws.close();
    this.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } });
    this.ev.removeAllListeners('connection.update');
  });

  readonly logout = vi.fn(async () => {
    await this.end(Object.assign(new Error('Intentional Logout'), { output: { statusCode: 401 } }));
  });

  readonly onWhatsApp = vi.fn(async (...jids: string[]) =>
    jids.map((jid) => ({ jid: jid.includes('@') ? jid : `${jid}@s.whatsapp.net`, exists: true })),
  );

  readonly sendMessage = vi.fn(async (jid: string, content: Record<string, any>) => ({
    key: { remoteJid: jid, fromMe: true, id: `FAKEMSG${++messageSeq}` },
    message: content.text ? { conversation: content.text } : { extendedTextMessage: { text: '' } },
    messageTimestamp: Math.floor(Date.now() / 1000),
    status: 1,
  }));

  readonly readMessages = vi.fn(async () => undefined);
  readonly chatModify = vi.fn(async () => undefined);
  // Upload de mídia para o CDN do WhatsApp: nada sobe, devolve um caminho falso.
  readonly waUploadToServer = vi.fn(async () => ({
    mediaUrl: 'https://mmg.whatsapp.net/fake',
    directPath: '/v/t62.0-24/fake',
  }));
  readonly sendPresenceUpdate = vi.fn(async () => undefined);
  readonly presenceSubscribe = vi.fn(async () => undefined);
  readonly profilePictureUrl = vi.fn(async () => undefined);
  readonly fetchStatus = vi.fn(async () => []);
  readonly updateMediaMessage = vi.fn();
  readonly groupFetchAllParticipating = vi.fn(async () => ({}));
  readonly groupMetadata = vi.fn();
  readonly requestPairingCode = vi.fn(async () => 'FAKECODE');
  readonly rejectCall = vi.fn();
  readonly waitForConnectionUpdate = vi.fn();
  readonly signalRepository = {
    lidMapping: {
      getPNForLID: vi.fn(async () => null),
      getLIDForPN: vi.fn(async () => null),
      storeLIDPNMappings: vi.fn(async () => undefined),
    },
  };

  constructor(readonly config: UserFacingSocketConfig) {
    this.authState = config.auth;
    sockets.push(this);
  }

  /** Simula o WhatsApp abrindo a conexão (o que acontece depois do QR lido). */
  open(user = { id: '5511900000001:1@s.whatsapp.net', name: 'Teste' }): void {
    this.user = user;
    this.ev.emit('connection.update', { connection: 'open' });
  }

  /** Simula um nó recebido no websocket (ex.: `CB:stream:error`). */
  receiveNode(tag: string, node: unknown): void {
    this.ws.emit(tag, node);
  }
}

export const makeFakeSocket = (config: UserFacingSocketConfig) => new FakeSocket(config);
