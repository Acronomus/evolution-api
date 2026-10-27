/**
 * patches/baileys+7.0.0-rc14.patch (be72dfc7) restaura o pareamento por QR depois
 * que o WhatsApp passou a mandar `companion_reg_refresh`. O patch é aplicado pelo
 * `postinstall` (patch-package); se a instalação pular o postinstall, ou se a
 * baileys mudar de versão, a imagem sai sem ele. Estes testes falham nesse caso.
 */
import fs from 'node:fs';
import path from 'node:path';

import P from 'pino';
import { describe, expect, it, vi } from 'vitest';

const BAILEYS = path.resolve(__dirname, '../../node_modules/baileys');

describe('patch da baileys', () => {
  it('está aplicado na versão instalada', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(BAILEYS, 'package.json'), 'utf8'));
    expect(fs.existsSync(path.resolve(__dirname, `../../patches/baileys+${version}.patch`))).toBe(true);

    const socket = fs.readFileSync(path.join(BAILEYS, 'lib/Socket/socket.js'), 'utf8');
    expect(socket).toContain('CB:notification,type:companion_reg_refresh');
    const recv = fs.readFileSync(path.join(BAILEYS, 'lib/Socket/messages-recv.js'), 'utf8');
    expect(recv).toContain("getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub')");
  });

  it('companion_reg_refresh rotaciona o segredo e redesenha o QR sem gastar ref', async () => {
    const { handleCompanionRegRefresh, makePairingQRRenderer } = (await import('baileys')) as any;
    const rendered: string[] = [];
    const renderer = makePairingQRRenderer(['ref-1', 'ref-2'], (ref: string) => rendered.push(ref));
    renderer.next();

    const creds: Record<string, unknown> = { advSecretKey: 'antigo' };
    const emitCredsUpdate = vi.fn();
    const result = handleCompanionRegRefresh(
      {
        tag: 'notification',
        attrs: { id: '1', type: 'companion_reg_refresh' },
        content: [{ tag: 'companion_reg_refresh', attrs: {} }],
      },
      { creds, emitCredsUpdate, refreshQR: () => renderer.refresh(), logger: P({ level: 'silent' }) },
    );

    expect(result).toBe('rotated');
    expect(creds.advSecretKey).not.toBe('antigo');
    expect(emitCredsUpdate).toHaveBeenCalledWith({ advSecretKey: creds.advSecretKey });
    expect(rendered).toEqual(['ref-1', 'ref-1']);
    expect(renderer.next()).toBe(true);
    expect(rendered).toEqual(['ref-1', 'ref-1', 'ref-2']);
  });

  it('sessão já pareada não tem o segredo trocado', async () => {
    const { handleCompanionRegRefresh } = (await import('baileys')) as any;
    const creds = { advSecretKey: 'atual', me: { id: '5511900000001:1@s.whatsapp.net' } };
    const refreshQR = vi.fn();

    const result = handleCompanionRegRefresh(
      { tag: 'notification', attrs: { id: '2' }, content: [{ tag: 'companion_reg_refresh', attrs: {} }] },
      { creds, emitCredsUpdate: vi.fn(), refreshQR, logger: P({ level: 'silent' }) },
    );

    expect(result).toBe('ignored_registered');
    expect(creds.advSecretKey).toBe('atual');
    expect(refreshQR).not.toHaveBeenCalled();
  });
});
