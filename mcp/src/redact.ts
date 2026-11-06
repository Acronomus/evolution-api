// Mascara segredos nas respostas: o token da instância (`token`/`hash`/`apikey`), senha de
// proxy, token do Chatwoot etc. O resultado das ferramentas vai para o contexto do modelo.

const SECRET_KEY = /(token|password|passwd|secret|apikey|api_key|hash|authorization)$/i;

export const MASK = '[oculto]';

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && typeof v === 'string' && v.length > 0) out[k] = MASK;
      else out[k] = redact(v);
    }
    return out as T;
  }
  return value;
}
