/**
 * Buffer dos logs do processo (build próprio da Acronomus), para o `GET /logs` e a ferramenta
 * `evolution_logs` do MCP.
 *
 * Captura o próprio stdout/stderr: guarda o mesmo que o `docker logs` mostra (Logger, baileys/pino,
 * console.log solto, stack traces), sem cores ANSI. Fica só em memória: zera a cada restart e cada
 * réplica tem o seu. Sempre ligado: o main.ts instala a captura no boot.
 */

export type LogStream = 'stdout' | 'stderr';

export interface LogLine {
  /** Momento em que a linha foi escrita (ms). */
  time: number;
  stream: LogStream;
  text: string;
}

export interface LogQuery {
  /** Últimas N linhas depois dos filtros. */
  tail?: number;
  /** Só linhas a partir deste momento (ms). */
  since?: number;
  /** Texto (sem diferenciar maiúsculas) ou expressão regular, conforme `regex`. */
  grep?: string;
  regex?: boolean;
  /** Linhas com `[nome]` da instância. */
  instance?: string;
  /** Níveis do Logger (ERROR, WARN, INFO...). */
  levels?: string[];
  stream?: LogStream;
}

export interface LogResult {
  lines: LogLine[];
  /** Linhas que passaram nos filtros (antes do `tail`). */
  matched: number;
  /** Linhas no buffer. */
  buffered: number;
  /** Linha mais antiga ainda no buffer (ms), ou null se vazio. */
  oldest: number | null;
}

export const DEFAULT_TAIL = 200;
/** Linhas guardadas (as mais antigas saem primeiro). */
export const BUFFER_LINES = 20_000;
/** Linha maior que isso é cortada (um objeto gigante logado não ocupa o buffer sozinho). */
export const MAX_LINE_CHARS = 4000;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export const LEVELS = ['ERROR', 'WARN', 'INFO', 'LOG', 'DEBUG', 'VERBOSE', 'DARK'] as const;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class LogBuffer {
  private readonly ring: (LogLine | undefined)[];
  private start = 0;
  private size = 0;
  private readonly partial: Record<LogStream, string> = { stdout: '', stderr: '' };

  constructor(
    readonly maxLines: number,
    private readonly now: () => number = Date.now,
  ) {
    this.ring = new Array(Math.max(1, maxLines));
  }

  /** Recebe um pedaço do stream; só guarda linhas completas (o resto espera o próximo `\n`). */
  write(stream: LogStream, chunk: string | Uint8Array): void {
    const text = this.partial[stream] + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const parts = text.split('\n');
    this.partial[stream] = parts.pop() ?? '';
    if (this.partial[stream].length > MAX_LINE_CHARS) {
      parts.push(this.partial[stream]);
      this.partial[stream] = '';
    }
    for (const raw of parts) {
      const clean = raw.replace(ANSI, '').replace(/\r$/, '');
      if (!clean.trim()) continue;
      this.push({
        time: this.now(),
        stream,
        text: clean.length > MAX_LINE_CHARS ? `${clean.slice(0, MAX_LINE_CHARS)}… [cortada]` : clean,
      });
    }
  }

  private push(line: LogLine) {
    const cap = this.ring.length;
    if (this.size < cap) {
      this.ring[(this.start + this.size) % cap] = line;
      this.size++;
    } else {
      this.ring[this.start] = line;
      this.start = (this.start + 1) % cap;
    }
  }

  private *all(): Generator<LogLine> {
    for (let i = 0; i < this.size; i++) yield this.ring[(this.start + i) % this.ring.length]!;
  }

  /** Lança erro com mensagem legível se o regex for inválido. */
  query(q: LogQuery = {}): LogResult {
    const tail = Math.max(1, Math.floor(q.tail ?? DEFAULT_TAIL));
    let pattern: RegExp | undefined;
    if (q.grep) {
      try {
        pattern = new RegExp(q.regex ? q.grep : escapeRegex(q.grep), 'i');
      } catch (err) {
        throw new Error(`regex inválido: ${(err as Error).message}`);
      }
    }
    const instance = q.instance ? `[${q.instance}]` : undefined;
    const levels = q.levels?.length
      ? new RegExp(`(^|\\s)(${q.levels.map((l) => escapeRegex(l.toUpperCase())).join('|')})\\s`)
      : undefined;

    const matched: LogLine[] = [];
    for (const line of this.all()) {
      if (q.since !== undefined && line.time < q.since) continue;
      if (q.stream && line.stream !== q.stream) continue;
      if (instance && !line.text.includes(instance)) continue;
      if (levels && !levels.test(line.text)) continue;
      if (pattern && !pattern.test(line.text)) continue;
      matched.push(line);
    }
    return {
      lines: matched.slice(-tail),
      matched: matched.length,
      buffered: this.size,
      oldest: this.size ? this.ring[this.start]!.time : null,
    };
  }
}

/**
 * `since` como o `docker logs`: ISO (`2026-11-13T10:00:00Z`) ou relativo (`30s`, `10m`, `2h`, `1d`).
 * Devolve ms, ou lança erro se não entender.
 */
export function parseSince(value: string, now = Date.now()): number {
  const rel = /^(\d+)\s*(s|m|h|d)$/i.exec(value.trim());
  if (rel) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
    return now - Number(rel[1]) * unit;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`since inválido: "${value}" (use ISO ou 30s, 10m, 2h, 1d)`);
  return t;
}

type Writable = { write: (...args: any[]) => boolean };

let installed: LogBuffer | undefined;

/** O buffer instalado no processo (undefined antes do boot, e nos testes que não instalam). */
export const logBuffer = (): LogBuffer | undefined => installed;

/**
 * Passa a copiar tudo o que vai para stdout/stderr para o buffer, sem mudar a saída.
 * Idempotente: a segunda chamada devolve o buffer já instalado.
 */
export function installLogCapture(
  maxLines: number,
  streams: Record<LogStream, Writable> = { stdout: process.stdout, stderr: process.stderr },
): LogBuffer {
  if (installed) return installed;
  const buffer = new LogBuffer(maxLines);
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = streams[name];
    const original = stream.write.bind(stream);
    stream.write = (chunk: any, ...rest: any[]) => {
      try {
        if (typeof chunk === 'string' || chunk instanceof Uint8Array) buffer.write(name, chunk);
      } catch {
        // o log nunca pode quebrar por causa do buffer
      }
      return original(chunk, ...rest);
    };
  }
  installed = buffer;
  return buffer;
}
