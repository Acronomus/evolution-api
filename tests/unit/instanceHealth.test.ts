/**
 * Detector de saúde da instância (src/utils/instanceHealth.ts): travada (acumulado offline não
 * terminou), quedas repetidas e celular offline, com antialarme de 1 h.
 */
import { HEALTH_LIMITS, HealthEvent, InstanceHealth } from '@utils/instanceHealth';
import { describe, expect, it, vi } from 'vitest';

const MIN = 60_000;

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-28T12:00:00Z'));
  const events: HealthEvent[] = [];
  const reconnect = vi.fn(async () => {});
  const h = new InstanceHealth('liga_72', { reconnect, onChange: (e) => events.push(e) });
  return { h, events, reconnect, advance: (ms: number) => vi.advanceTimersByTimeAsync(ms) };
}
const open = (h: InstanceHealth) => {
  h.onConnectionUpdate({ connection: 'connecting', receivedPendingNotifications: false });
  h.onConnectionUpdate({ connection: 'open' });
};
const closeWith = (h: InstanceHealth, code: number) =>
  h.onConnectionUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });

describe('travada', () => {
  it('open sem receivedPendingNotifications em 60 s reconecta uma vez e avisa', async () => {
    const { h, events, reconnect, advance } = setup();
    open(h);
    await advance(59_000);
    expect(events).toHaveLength(0);
    await advance(2_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ instance: 'liga_72', estado: 'travada', acao: 'reconectou' });
    vi.useRealTimers();
  });

  it('acumulado concluído a tempo não alerta', async () => {
    const { h, events, reconnect, advance } = setup();
    open(h);
    await advance(10_000);
    h.onConnectionUpdate({ receivedPendingNotifications: true });
    await advance(120_000);
    expect(events).toHaveLength(0);
    expect(reconnect).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('travar de novo na conexão seguinte só avisa, sem laço; voltar gera "ok"', async () => {
    const { h, events, reconnect, advance } = setup();
    open(h);
    await advance(61_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    // o close causado pela reconexão não conta como queda
    closeWith(h, 515);
    open(h);
    await advance(61_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    // mesmo estado: antialarme não repete o evento
    expect(events.filter((e) => e.estado === 'travada')).toHaveLength(1);
    h.onConnectionUpdate({ receivedPendingNotifications: true });
    expect(events[events.length - 1]).toMatchObject({ estado: 'ok', acao: 'nenhuma' });
    vi.useRealTimers();
  });
});

describe('quedas_repetidas', () => {
  it('3 quedas com o mesmo motivo em 3 h', () => {
    const { h, events } = setup();
    closeWith(h, 428);
    closeWith(h, 428);
    closeWith(h, 500);
    expect(events).toHaveLength(0);
    closeWith(h, 428);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ estado: 'quedas_repetidas', detalhes: { quedas: 3, motivoQueda: '428' } });
    vi.useRealTimers();
  });

  it('quedas fora da janela de 3 h não contam e o estado volta a ok', async () => {
    const { h, events, advance } = setup();
    h.start();
    closeWith(h, 428);
    closeWith(h, 428);
    closeWith(h, 428);
    expect(events).toHaveLength(1);
    await advance(HEALTH_LIMITS.DROPS_WINDOW_MS + 2 * MIN);
    expect(events[events.length - 1]?.estado).toBe('ok');
    h.dispose();
    vi.useRealTimers();
  });
});

describe('celular_offline', () => {
  it('5 PDO sem resposta em 30 min', () => {
    const { h, events } = setup();
    for (let i = 0; i < 4; i++) h.onPdoNoResponse();
    expect(events).toHaveLength(0);
    h.onPdoNoResponse();
    expect(events[0]).toMatchObject({ estado: 'celular_offline', detalhes: { pedidosSemResposta: 5 } });
    vi.useRealTimers();
  });

  it('antialarme: o mesmo alerta não repete em menos de 1 h, mas repete depois', async () => {
    const { h, events, advance } = setup();
    h.start();
    const burst = () => {
      for (let i = 0; i < 5; i++) h.onPdoNoResponse();
    };
    burst();
    await advance(31 * MIN); // janela esvazia -> ok
    expect(events.map((e) => e.estado)).toEqual(['celular_offline', 'ok']);
    burst(); // 31 min depois do primeiro alerta: suprimido
    expect(events).toHaveLength(2);
    await advance(31 * MIN); // volta a ok (suprimido, pois o último emitido foi ok)
    expect(events).toHaveLength(2);
    await advance(MIN);
    burst(); // > 1 h
    expect(events[events.length - 1]?.estado).toBe('celular_offline');
    h.dispose();
    vi.useRealTimers();
  });
});
