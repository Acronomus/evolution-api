// Cliente HTTP mínimo da Evolution API. Autentica com a chave global (header `apikey`),
// que é a única que cria, lista e apaga instâncias.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface EvolutionClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

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

export function createEvolutionClient(opts: EvolutionClientOptions): EvolutionClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return {
    async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      const headers: Record<string, string> = { apikey: opts.apiKey, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';

      let res: Response;
      try {
        res = await doFetch(baseUrl + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new EvolutionError(`Falha ao chamar a Evolution (${method} ${path}): ${reason}`, 0, null);
      }

      const text = await res.text();
      let parsed: unknown = text;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // resposta não-JSON: fica como texto
        }
      }

      if (!res.ok) {
        throw new EvolutionError(
          `Evolution respondeu ${res.status} em ${method} ${path}: ${errorMessage(parsed, res.statusText)}`,
          res.status,
          parsed,
        );
      }
      // Alguns controllers devolvem 200/201 com `{ error: true, message }` em vez de status de erro.
      if (parsed && typeof parsed === 'object' && (parsed as any).error === true) {
        throw new EvolutionError(
          `Evolution recusou ${method} ${path}: ${errorMessage(parsed, 'erro sem mensagem')}`,
          res.status,
          parsed,
        );
      }
      return parsed as T;
    },
  };
}
