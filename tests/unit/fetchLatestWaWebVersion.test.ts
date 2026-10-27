/**
 * `GET /` (o healthcheck) chama fetchLatestWaWebVersion a cada requisição. A
 * correção do build próprio (08aadd2b) pôs cache, timeout e dedupe para o
 * healthcheck não depender de web.whatsapp.com a cada batida.
 */
import axios from 'axios';
import nock from 'nock';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Corpo montado à mão (JavaScript, como o sw.js), só com o trecho que o regex lê.
const SW_JS = 'self.__d={"client_revision":1012345678,"x":1};';

const load = async () => {
  vi.resetModules();
  return (await import('@utils/fetchLatestWaWebVersion')).fetchLatestWaWebVersion;
};

// O primeiro import da baileys é lento; fora do tempo dos testes.
beforeAll(async () => {
  await import('baileys');
}, 60_000);

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fetchLatestWaWebVersion', () => {
  it('lê a revisão do sw.js e guarda por 1 hora', async () => {
    const fetchVersion = await load();
    const scope = nock('https://web.whatsapp.com').get('/sw.js').once().reply(200, SW_JS);

    const first = await fetchVersion({});
    const second = await fetchVersion({});

    expect(first).toEqual({ version: [2, 3000, 1012345678], isLatest: true });
    expect(second).toBe(first);
    expect(scope.isDone()).toBe(true);
  });

  it('chamadas simultâneas com o cache frio fazem uma busca só', async () => {
    const fetchVersion = await load();
    nock('https://web.whatsapp.com').get('/sw.js').once().delay(50).reply(200, SW_JS);

    const results = await Promise.all([fetchVersion({}), fetchVersion({}), fetchVersion({})]);

    expect(results.every((r) => r.isLatest)).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('pede com timeout de 10 s', async () => {
    const fetchVersion = await load();
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: SW_JS });

    await fetchVersion({});

    expect(get).toHaveBeenCalledWith('https://web.whatsapp.com/sw.js', expect.objectContaining({ timeout: 10_000 }));
  });

  it('sem resposta do WhatsApp cai na versão da baileys e tenta de novo depois de 5 min', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchVersion = await load();
    nock('https://web.whatsapp.com').get('/sw.js').once().reply(503);

    const fallback = await fetchVersion({});
    expect(fallback.isLatest).toBe(false);
    expect(fallback.version).toHaveLength(3);
    expect(await fetchVersion({})).toBe(fallback);

    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    nock('https://web.whatsapp.com').get('/sw.js').once().reply(200, SW_JS);
    expect(await fetchVersion({})).toEqual({ version: [2, 3000, 1012345678], isLatest: true });
  });
});
