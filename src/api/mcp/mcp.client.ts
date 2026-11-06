import http from 'http';
import https from 'https';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** O que as ferramentas do MCP precisam da API: uma chamada REST com a chave de quem chamou. */
export interface EvolutionClient {
  request<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
}

export class EvolutionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'EvolutionError';
  }
}

/** Tira a mensagem legível dos formatos de erro da Evolution. */
export function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, any>;
    const inner = b.response?.message ?? b.message ?? b.error;
    if (Array.isArray(inner)) return inner.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('; ');
    if (typeof inner === 'string') return inner;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 500);
  return fallback;
}

/** Interpreta a resposta da API: status de erro, ou 200 com `{ error: true }`, vira EvolutionError. */
export function parseResponse<T>(method: string, path: string, status: number, text: string): T {
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // resposta não-JSON: fica como texto
    }
  }
  if (status >= 400) {
    throw new EvolutionError(
      `Evolution respondeu ${status} em ${method} ${path}: ${errorMessage(parsed, 'erro sem mensagem')}`,
      status,
      parsed,
    );
  }
  if (parsed && typeof parsed === 'object' && (parsed as any).error === true) {
    throw new EvolutionError(
      `Evolution recusou ${method} ${path}: ${errorMessage(parsed, 'erro sem mensagem')}`,
      status,
      parsed,
    );
  }
  return parsed as T;
}

export interface LoopbackTarget {
  port: number;
  /** O servidor da Evolution está em HTTPS (SERVER_TYPE=https). */
  tls: boolean;
}

/**
 * Cliente que chama a própria API por loopback (127.0.0.1, na porta em que o pedido do MCP
 * chegou), com a apikey de quem chamou. Os guards da API decidem o que essa chave pode fazer:
 * a global vê tudo; o token de uma instância só passa nas rotas dela.
 */
export function createLoopbackClient(target: LoopbackTarget, apikey: string, timeoutMs = 60_000): EvolutionClient {
  const transport = target.tls ? https : http;
  return {
    request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      return new Promise<T>((resolve, reject) => {
        const req = transport.request(
          {
            host: '127.0.0.1',
            port: target.port,
            method,
            path,
            headers: {
              apikey,
              accept: 'application/json',
              ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
            },
            // Loopback para o próprio processo: o certificado é do domínio público, não de 127.0.0.1.
            ...(target.tls ? { rejectUnauthorized: false } : {}),
            timeout: timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              try {
                resolve(parseResponse<T>(method, path, res.statusCode ?? 500, Buffer.concat(chunks).toString('utf8')));
              } catch (err) {
                reject(err);
              }
            });
            res.on('error', reject);
          },
        );
        req.on('timeout', () => req.destroy(new Error(`timeout de ${timeoutMs} ms`)));
        req.on('error', (err) =>
          reject(new EvolutionError(`Falha ao chamar a API (${method} ${path}): ${err.message}`, 0, null)),
        );
        if (payload) req.write(payload);
        req.end();
      });
    },
  };
}
