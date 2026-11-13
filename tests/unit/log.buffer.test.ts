/**
 * Buffer de logs (src/api/logs/log.buffer.ts) e mascaramento de texto (redactText): a base do
 * `GET /logs` e da ferramenta `evolution_logs` do MCP.
 */
import { installLogCapture, LogBuffer, MAX_LINE_CHARS, MAX_TAIL, parseSince } from '@api/logs/log.buffer';
import { MASK, redactText } from '@api/mcp/mcp.redact';
import { describe, expect, it } from 'vitest';

const clock = (start = 1_000) => {
  let t = start;
  const now = () => t;
  return { now, set: (v: number) => (t = v) };
};

const line = (level: string, ctx: string, msg: string, instance = '') =>
  `[Evolution API] ${instance ? `[${instance}] ` : ''}123 - Fri Nov 13 2026 10:00:00   ${level}  [${ctx}] [string] ${msg}\n`;

describe('LogBuffer', () => {
  it('guarda linhas completas, junta pedaços e tira as cores ANSI', () => {
    const b = new LogBuffer(10);
    b.write('stdout', 'primeira\nseg');
    expect(b.query().lines.map((l) => l.text)).toEqual(['primeira']);
    b.write('stdout', 'unda\n\x1b[31m\x1b[1mERROR\x1b[0m vermelha\n\n');
    expect(b.query().lines.map((l) => l.text)).toEqual(['primeira', 'segunda', 'ERROR vermelha']);
  });

  it('stdout e stderr não misturam pedaços', () => {
    const b = new LogBuffer(10);
    b.write('stdout', 'a');
    b.write('stderr', 'erro\n');
    b.write('stdout', 'b\n');
    expect(b.query().lines.map((l) => [l.stream, l.text])).toEqual([
      ['stderr', 'erro'],
      ['stdout', 'ab'],
    ]);
  });

  it('descarta as mais antigas quando enche', () => {
    const b = new LogBuffer(3);
    for (let i = 1; i <= 5; i++) b.write('stdout', `l${i}\n`);
    const r = b.query();
    expect(r.lines.map((l) => l.text)).toEqual(['l3', 'l4', 'l5']);
    expect(r.buffered).toBe(3);
  });

  it('tail devolve as últimas N depois dos filtros e respeita o máximo', () => {
    const b = new LogBuffer(5000);
    for (let i = 1; i <= 3000; i++) b.write('stdout', `l${i}\n`);
    expect(b.query({ tail: 2 }).lines.map((l) => l.text)).toEqual(['l2999', 'l3000']);
    expect(b.query().lines).toHaveLength(200);
    expect(b.query({ tail: 99_999 }).lines).toHaveLength(MAX_TAIL);
    expect(b.query({ tail: 2, grep: 'l1' }).lines.map((l) => l.text)).toEqual(['l1998', 'l1999']);
    expect(b.query({ grep: 'l1' }).matched).toBe(1111);
  });

  it('filtra por since, grep, regex, instância, nível e stream', () => {
    const c = clock();
    const b = new LogBuffer(100, c.now);
    b.write('stdout', line('INFO', 'ChannelStartupService', 'conectou', 'loja-a'));
    c.set(2_000);
    b.write('stdout', line('ERROR', 'ChannelStartupService', 'Connection Closed', 'loja-b'));
    b.write('stdout', line('WARN', 'WebhookService', 'retry 3', 'loja-a'));
    b.write('stderr', 'Error: boom\n    at foo (x.ts:1)\n');

    expect(b.query({ since: 2_000 }).matched).toBe(4);
    expect(b.query({ since: 2_001 }).matched).toBe(0);
    expect(b.query({ instance: 'loja-a' }).lines.map((l) => l.text)).toEqual([
      expect.stringContaining('conectou'),
      expect.stringContaining('retry 3'),
    ]);
    expect(b.query({ levels: ['error', 'WARN'] }).matched).toBe(2);
    expect(b.query({ grep: 'connection closed' }).matched).toBe(1);
    expect(b.query({ grep: 'retry \\d', regex: true }).matched).toBe(1);
    expect(b.query({ grep: 'retry \\d' }).matched).toBe(0);
    expect(b.query({ stream: 'stderr' }).lines.map((l) => l.text)).toEqual(['Error: boom', '    at foo (x.ts:1)']);
    expect(b.query().oldest).toBe(1_000);
  });

  it('regex inválido vira erro legível', () => {
    expect(() => new LogBuffer(1).query({ grep: '(', regex: true })).toThrow(/regex inválido/);
  });

  it('corta linhas gigantes', () => {
    const b = new LogBuffer(10);
    b.write('stdout', 'x'.repeat(MAX_LINE_CHARS * 3));
    const [l] = b.query().lines;
    expect(l.text.length).toBeLessThan(MAX_LINE_CHARS + 20);
    expect(l.text).toMatch(/\[cortada\]$/);
  });
});

describe('parseSince', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  it('aceita relativo e ISO', () => {
    expect(parseSince('30s', now)).toBe(now - 30_000);
    expect(parseSince('10m', now)).toBe(now - 600_000);
    expect(parseSince('2h', now)).toBe(now - 7_200_000);
    expect(parseSince('1d', now)).toBe(now - 86_400_000);
    expect(parseSince('2026-11-13T10:00:00Z', now)).toBe(Date.parse('2026-11-13T10:00:00Z'));
  });
  it('recusa o que não entende', () => {
    expect(() => parseSince('ontem', now)).toThrow(/since inválido/);
  });
});

describe('installLogCapture', () => {
  it('copia para o buffer sem mudar a saída e é idempotente', () => {
    const out: string[] = [];
    const err: string[] = [];
    const streams = {
      stdout: { write: (c: any) => (out.push(String(c)), true) },
      stderr: { write: (c: any) => (err.push(String(c)), true) },
    };
    const b = installLogCapture(10, streams);
    expect(streams.stdout.write('oi\n')).toBe(true);
    streams.stderr.write(Buffer.from('falhou\n'));
    expect(out).toEqual(['oi\n']);
    expect(err).toEqual(['falhou\n']);
    expect(b.query().lines.map((l) => l.text)).toEqual(['oi', 'falhou']);
    expect(installLogCapture(99, streams)).toBe(b);
  });
});

describe('redactText', () => {
  it('mascara apikey, token, senha e Bearer em texto livre', () => {
    const t = redactText(
      `{ apikey: 'ABC123', "token":"T-1", password=segredo } authorization: Bearer eyJ.x-y headers: { Authorization: 'Bearer zzz' }`,
    );
    for (const s of ['ABC123', 'T-1', 'segredo', 'eyJ.x-y', 'zzz']) expect(t).not.toContain(s);
    expect(t).toContain(MASK);
  });
  it('não mexe no resto', () => {
    expect(redactText('Connection Closed loja-a')).toBe('Connection Closed loja-a');
  });
});
