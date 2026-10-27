import nock from 'nock';
import { beforeEach, describe, expect, it } from 'vitest';

import { api, GLOBAL_KEY } from './helpers/app';
import { resetDb } from './helpers/db';

beforeEach(resetDb);

describe('GET / (healthcheck)', () => {
  it('responde com a versão do WhatsApp Web lida do sw.js', async () => {
    // Corpo montado à mão (JavaScript, como o sw.js), só com o trecho que o regex lê.
    // Não é gravação real: formato não confirmado contra o arquivo atual do WhatsApp.
    nock('https://web.whatsapp.com').get('/sw.js').reply(200, 'self.__d={"client_revision":1012345678,"x":1};');

    const res = await (await api()).get('/');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 200,
      clientName: 'evolution_test',
      whatsappWebVersion: '2.3000.1012345678',
    });
  });

  it('rota desconhecida devolve 404 no formato do app', async () => {
    const res = await (await api()).get('/nao-existe');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ status: 404, error: 'Not Found' });
  });
});

describe('POST /verify-creds', () => {
  it('aceita a chave global', async () => {
    const res = await (await api()).post('/verify-creds').set(GLOBAL_KEY);
    expect(res.status).toBe(200);
  });

  it('recusa sem chave e com chave errada', async () => {
    const http = await api();
    expect((await http.post('/verify-creds')).status).toBe(401);
    expect((await http.post('/verify-creds').set({ apikey: 'errada' })).status).toBe(401);
  });
});
