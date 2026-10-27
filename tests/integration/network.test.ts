/** A suíte não pode falar com a internet: confere o corte de rede do setup. */
import net from 'node:net';

import axios from 'axios';
import { describe, expect, it } from 'vitest';

describe('rede cortada nos testes', () => {
  it('HTTP para fora falha', async () => {
    await expect(axios.get('https://example.com/')).rejects.toThrow();
  });

  it('fetch para fora falha', async () => {
    await expect(fetch('https://example.com/')).rejects.toThrow();
  });

  it('socket TCP para fora falha', () => {
    expect(() => net.connect({ host: '93.184.215.14', port: 443 })).toThrow(/Rede cortada/);
  });
});
