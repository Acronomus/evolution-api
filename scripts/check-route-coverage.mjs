/**
 * Falha se alguma rota do app não foi atingida pela suíte de integração.
 *
 * Uso: npm run test:integration && npm run test:routes
 *
 * - .route-coverage/routes.txt: todas as rotas do app, gravadas pelo próprio app
 *   montado nos testes (tests/integration/helpers/app.ts). Rota nova entra sozinha.
 * - .route-coverage/hits-*.txt: rotas que algum teste atingiu.
 * - tests/integration/routes-pending.txt: rotas que ainda não têm teste. Esta lista
 *   só diminui: rota nova sem teste falha, e rota da lista que ganhou teste (ou
 *   deixou de existir) também falha até sair da lista.
 *
 * --write regrava a lista de pendentes com o que falta hoje (só para criar a lista).
 *
 * Script em JS puro, sem carregar o app: o tsx não consegue carregar a baileys 7 (ESM).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HITS_DIR = path.join(ROOT, '.route-coverage');
const ROUTES_FILE = path.join(HITS_DIR, 'routes.txt');
const PENDING_FILE = path.join(ROOT, 'tests/integration/routes-pending.txt');

const readLines = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : [];

if (!fs.existsSync(ROUTES_FILE)) {
  console.error('Nenhuma rota registrada: rode `npm run test:integration` antes.');
  process.exit(1);
}

const routes = readLines(ROUTES_FILE);
const hits = new Set(
  fs
    .readdirSync(HITS_DIR)
    .filter((f) => f.startsWith('hits-'))
    .flatMap((f) => readLines(path.join(HITS_DIR, f))),
);
const missing = routes.filter((r) => !hits.has(r));

if (process.argv.includes('--write')) {
  fs.writeFileSync(
    PENDING_FILE,
    '# Rotas ainda sem teste de integração. Esta lista só diminui (scripts/check-route-coverage.mjs).\n' +
      missing.join('\n') +
      '\n',
  );
  console.log(`${missing.length} rotas pendentes gravadas em ${path.relative(ROOT, PENDING_FILE)}`);
  process.exit(0);
}

const pending = new Set(readLines(PENDING_FILE));
const routeSet = new Set(routes);
const uncovered = missing.filter((r) => !pending.has(r));
const nowCovered = [...pending].filter((r) => routeSet.has(r) && hits.has(r));
const gone = [...pending].filter((r) => !routeSet.has(r));

console.log(
  `Rotas: ${routes.length} · com teste: ${routes.length - missing.length} · pendentes na lista: ${pending.size}`,
);

const problems = [];
if (uncovered.length) problems.push(`Rotas sem teste de integração (escreva o teste):\n  ${uncovered.join('\n  ')}`);
if (nowCovered.length)
  problems.push(`Rotas que ganharam teste (tire de routes-pending.txt):\n  ${nowCovered.join('\n  ')}`);
if (gone.length) problems.push(`Rotas que não existem mais (tire de routes-pending.txt):\n  ${gone.join('\n  ')}`);

if (problems.length) {
  console.error(problems.join('\n\n'));
  process.exit(1);
}
