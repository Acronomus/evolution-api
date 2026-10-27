/**
 * Cache de números no WhatsApp (tabela IsOnWhatsapp). Correção do build próprio
 * (faed6a53): `jidOptions` é uma lista separada por vírgula e a busca era por
 * substring, então o número do DDD 19 casava com o do DDD 51 (um é substring do
 * outro) e os registros se misturavam. Também trata a corrida no create.
 */
import { prismaRepository } from '@api/server.module';
import { getOnWhatsappCache, saveOnWhatsappCache } from '@utils/onWhatsappCache';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb } from './helpers/db';

beforeEach(resetDb);

const DDD19 = '551998325334@s.whatsapp.net';
const DDD51 = '5551998325334@s.whatsapp.net';

describe('saveOnWhatsappCache / getOnWhatsappCache', () => {
  it('números em que um é substring do outro ficam em registros separados', async () => {
    await saveOnWhatsappCache([{ remoteJid: DDD51 }]);
    await saveOnWhatsappCache([{ remoteJid: DDD19 }]);

    const rows = await prismaRepository.isOnWhatsapp.findMany({ orderBy: { remoteJid: 'asc' } });
    expect(rows.map((r) => r.remoteJid).sort()).toEqual([DDD19, DDD51].sort());
    for (const row of rows) {
      const other = row.remoteJid === DDD19 ? DDD51 : DDD19;
      expect(row.jidOptions.split(',')).not.toContain(other);
    }

    const found = await getOnWhatsappCache([DDD19]);
    expect(found.map((r) => r.remoteJid)).toEqual([DDD19]);
  });

  it('guarda o LID junto do telefone', async () => {
    await saveOnWhatsappCache([{ remoteJid: DDD51, remoteJidAlt: '123456789012345@lid', lid: 'lid' }]);

    const [row] = await prismaRepository.isOnWhatsapp.findMany();
    expect(row.remoteJid).toBe(DDD51);
    expect(row.jidOptions.split(',')).toContain('123456789012345@lid');
  });

  it('dois itens do mesmo número na mesma chamada não estouram a unique', async () => {
    await saveOnWhatsappCache([{ remoteJid: DDD51 }, { remoteJid: `+${DDD51}` }]);

    expect(await prismaRepository.isOnWhatsapp.count()).toBe(1);
  });
});
