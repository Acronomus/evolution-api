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

// Em texto livre (linhas de log): `apikey: 'x'`, `"token":"x"`, `password=x`, `Bearer x`.
const SECRET_PAIR =
  /((?:token|password|passwd|secret|apikey|api_key|hash|authorization)["']?\s*[:=]\s*["']?)(?!\[oculto\])([^\s"',}\]]+)/gi;
const BEARER = /(Bearer\s+)(?!\[oculto\])[\w.~+/=-]+/gi;

export function redactText(text: string): string {
  return text.replace(BEARER, `$1${MASK}`).replace(SECRET_PAIR, `$1${MASK}`);
}
