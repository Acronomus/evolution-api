#!/usr/bin/env bash
# Reconstrói manager/dist a partir do submódulo evolution-manager-v2 (upstream, no commit
# fixado) + os patches da Acronomus em manager-patches/ (ex.: a aba MCP).
#
# Uso: scripts/build-manager.sh   (precisa de rede para o submódulo e o npm)
# Depois: confira a tela (/manager) e commite manager/dist e, se mudou, o patch.
set -euo pipefail
cd "$(dirname "$0")/.."

git submodule update --init evolution-manager-v2
cd evolution-manager-v2
git checkout -- . && git clean -fdq
for p in ../manager-patches/*.patch; do
  echo "aplicando $(basename "$p")"
  git apply --whitespace=nowarn "$p"
done
npm ci
npx tsc -b
npx vite build --outDir ../manager/dist --emptyOutDir
echo "manager/dist reconstruído"
