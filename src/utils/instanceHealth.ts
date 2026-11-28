/**
 * Detector de saúde de uma instância do WhatsApp, só com sinais do protocolo (nunca o conteúdo das
 * mensagens). Estado em memória, um monitor por instância.
 *
 *  - travada: depois de `connection: 'open'` o Baileys não emitiu `receivedPendingNotifications: true`
 *    em 60 s, ou seja, o acumulado offline não terminou (bug do offline_batch, 28/11/2026). Reconecta
 *    UMA vez; se a conexão seguinte também travar, só avisa (sem laço).
 *  - quedas_repetidas: 3 ou mais desconexões com o mesmo motivo em 3 h.
 *  - celular_offline: 5 ou mais pedidos de reenvio ao celular (PDO) sem resposta em 30 min.
 *
 * Cada mudança de estado chama `onChange`. O mesmo alerta da mesma instância não se repete em menos de 1 h.
 */

export type HealthEstado = 'ok' | 'travada' | 'quedas_repetidas' | 'celular_offline';
export type HealthAcao = 'reconectou' | 'nenhuma';

export interface HealthEvent {
  instance: string;
  estado: HealthEstado;
  motivo: string;
  detalhes: Record<string, unknown>;
  desde: string;
  acao: HealthAcao;
}

export interface HealthOptions {
  /** Reconecta a instância (mesmo caminho do restart do service). */
  reconnect: () => Promise<void> | void;
  onChange: (event: HealthEvent) => void;
  warn?: (message: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const HEALTH_LIMITS = {
  SYNC_TIMEOUT_MS: 60_000,
  DROPS_WINDOW_MS: 3 * 60 * 60_000,
  DROPS_THRESHOLD: 3,
  PDO_WINDOW_MS: 30 * 60_000,
  PDO_THRESHOLD: 5,
  REALERT_MS: 60 * 60_000,
  TICK_MS: 60_000,
} as const;

const PRIORIDADE: HealthEstado[] = ['travada', 'quedas_repetidas', 'celular_offline'];

export class InstanceHealth {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private synced = false;
  private stalled = false;
  private reconnectedForStall = false;
  private ignoreNextClose = false;
  private syncTimer: unknown = null;
  private tickTimer: unknown = null;

  private drops: Array<{ at: number; key: string }> = [];
  private pdo: number[] = [];

  private estado: HealthEstado = 'ok';
  private desde = 0;
  private acao: HealthAcao = 'nenhuma';
  private lastEmitted: { estado: HealthEstado; at: number } | null = null;
  private lastAlertAt = new Map<HealthEstado, number>();

  constructor(
    private readonly instanceName: string | (() => string),
    private readonly opts: HealthOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get instance(): string {
    return typeof this.instanceName === 'function' ? this.instanceName() : this.instanceName;
  }

  /** Liga a reavaliação periódica (para os alertas de janela voltarem ao normal sozinhos). */
  start() {
    if (this.tickTimer) return;
    const loop = () => {
      this.evaluate();
      this.tickTimer = this.setTimer(loop, HEALTH_LIMITS.TICK_MS);
    };
    this.tickTimer = this.setTimer(loop, HEALTH_LIMITS.TICK_MS);
  }

  dispose() {
    this.cancelSyncTimer();
    if (this.tickTimer) this.clearTimer(this.tickTimer);
    this.tickTimer = null;
  }

  /** Alimentar com cada `connection.update` do Baileys. */
  onConnectionUpdate(update: {
    connection?: string;
    receivedPendingNotifications?: boolean;
    lastDisconnect?: { error?: any } | undefined;
  }) {
    const { connection, receivedPendingNotifications, lastDisconnect } = update;

    if (connection === 'connecting') {
      this.synced = false;
      this.cancelSyncTimer();
    }

    if (connection === 'open' && !this.synced) {
      this.armSyncTimer();
    }

    if (receivedPendingNotifications === true) {
      this.synced = true;
      this.cancelSyncTimer();
      this.stalled = false;
      this.reconnectedForStall = false;
      this.evaluate();
    }

    if (connection === 'close') {
      this.synced = false;
      this.cancelSyncTimer();
      if (this.ignoreNextClose) {
        this.ignoreNextClose = false;
      } else {
        this.drops.push({ at: this.now(), key: InstanceHealth.dropKey(lastDisconnect?.error) });
        this.evaluate();
      }
    }
  }

  /** Pedido de reenvio ao celular que ficou sem resposta (evento `pdo.no-response` da baileys patcheada). */
  onPdoNoResponse() {
    this.pdo.push(this.now());
    this.evaluate();
  }

  snapshot() {
    return { estado: this.estado, desde: this.desde ? new Date(this.desde).toISOString() : null };
  }

  static dropKey(error: any): string {
    const code = error?.output?.statusCode ?? error?.statusCode;
    if (code !== undefined && code !== null) return String(code);
    return String(error?.message ?? 'desconhecido').slice(0, 120);
  }

  private armSyncTimer() {
    this.cancelSyncTimer();
    this.syncTimer = this.setTimer(() => {
      this.syncTimer = null;
      if (this.synced) return;
      this.stalled = true;
      const reconnect = !this.reconnectedForStall;
      this.reconnectedForStall = true;
      this.evaluate(reconnect ? 'reconectou' : 'nenhuma');
      if (reconnect) {
        this.ignoreNextClose = true;
        Promise.resolve()
          .then(() => this.opts.reconnect())
          .catch((error) => {
            this.ignoreNextClose = false;
            this.opts.warn?.(`Instance "${this.instance}" - falha ao reconectar instância travada: ${error}`);
          });
      }
    }, HEALTH_LIMITS.SYNC_TIMEOUT_MS);
  }

  private cancelSyncTimer() {
    if (this.syncTimer) this.clearTimer(this.syncTimer);
    this.syncTimer = null;
  }

  private evaluate(acao?: HealthAcao) {
    const t = this.now();
    this.drops = this.drops.filter((d) => t - d.at < HEALTH_LIMITS.DROPS_WINDOW_MS);
    this.pdo = this.pdo.filter((at) => t - at < HEALTH_LIMITS.PDO_WINDOW_MS);

    const counts = new Map<string, number>();
    for (const d of this.drops) counts.set(d.key, (counts.get(d.key) ?? 0) + 1);
    let topKey = '';
    let topCount = 0;
    for (const [key, n] of counts) {
      if (n > topCount) {
        topKey = key;
        topCount = n;
      }
    }

    const ativos: Record<string, { motivo: string; detalhes: Record<string, unknown> }> = {};
    if (this.stalled && !this.synced) {
      ativos.travada = {
        motivo: `acumulado offline não terminou em ${HEALTH_LIMITS.SYNC_TIMEOUT_MS / 1000}s após conectar`,
        detalhes: { timeoutSegundos: HEALTH_LIMITS.SYNC_TIMEOUT_MS / 1000 },
      };
    }
    if (topCount >= HEALTH_LIMITS.DROPS_THRESHOLD) {
      ativos.quedas_repetidas = {
        motivo: `${topCount} desconexões com o mesmo motivo (${topKey}) em 3 h`,
        detalhes: { quedas: topCount, motivoQueda: topKey, janelaHoras: 3 },
      };
    }
    if (this.pdo.length >= HEALTH_LIMITS.PDO_THRESHOLD) {
      ativos.celular_offline = {
        motivo: `${this.pdo.length} pedidos de reenvio ao celular sem resposta em 30 min`,
        detalhes: { pedidosSemResposta: this.pdo.length, janelaMinutos: 30 },
      };
    }

    const novo: HealthEstado = PRIORIDADE.find((e) => ativos[e]) ?? 'ok';
    if (novo === this.estado) return;

    this.estado = novo;
    this.desde = t;
    this.acao = novo === 'travada' ? (acao ?? 'nenhuma') : 'nenhuma';
    this.emit(novo, novo === 'ok' ? null : ativos[novo]);
  }

  private emit(estado: HealthEstado, info: { motivo: string; detalhes: Record<string, unknown> } | null) {
    const t = this.now();

    if (estado === 'ok') {
      // Só avisa a volta se o último aviso emitido foi um alerta.
      if (!this.lastEmitted || this.lastEmitted.estado === 'ok') return;
    } else {
      const last = this.lastAlertAt.get(estado);
      if (last !== undefined && t - last < HEALTH_LIMITS.REALERT_MS) return;
      this.lastAlertAt.set(estado, t);
    }

    this.lastEmitted = { estado, at: t };
    const event: HealthEvent = {
      instance: this.instance,
      estado,
      motivo: info?.motivo ?? 'instância voltou ao normal',
      detalhes: info?.detalhes ?? {},
      desde: new Date(this.desde).toISOString(),
      acao: this.acao,
    };
    this.opts.warn?.(
      `Instance "${this.instance}" - saúde: ${estado} (${event.motivo})${event.acao === 'reconectou' ? ' - reconectando' : ''}`,
    );
    try {
      this.opts.onChange(event);
    } catch (error) {
      this.opts.warn?.(`Instance "${this.instance}" - falha ao emitir evento de saúde: ${error}`);
    }
  }
}
