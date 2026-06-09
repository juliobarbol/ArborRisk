#!/bin/bash
# SessionStart hook — ArborRisk
# Instala un navegador headless (chrome-headless-shell / Chrome for Testing)
# + puppeteer-core para poder testear la PWA (Service Worker, offline, mapa)
# en sesiones de Claude Code on the web.
#
# Es idempotente: si ya está instalado, no vuelve a bajar nada.
set -euo pipefail

# Solo en el entorno remoto efímero de Claude Code on the web.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Chrome for Testing: el binario se baja de storage.googleapis.com, host
# permitido por la network policy (a diferencia de cdnjs / el .deb de Chrome).
CHROME_VERSION="131.0.6778.204"
CACHE_DIR="$HOME/.cache/arbor-headless"
CHROME_DIR="$CACHE_DIR/chrome-headless-shell-linux64"
CHROME_BIN="$CHROME_DIR/chrome-headless-shell"
TOOLS_DIR="$CACHE_DIR/tools"

# 1) chrome-headless-shell -------------------------------------------------
if [ ! -x "$CHROME_BIN" ]; then
  mkdir -p "$CACHE_DIR"
  ZIP="$CACHE_DIR/chs.zip"
  URL="https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-headless-shell-linux64.zip"
  echo "[session-start] Descargando chrome-headless-shell ${CHROME_VERSION}…"
  curl -fsSL -o "$ZIP" "$URL"
  unzip -q -o "$ZIP" -d "$CACHE_DIR"
  chmod +x "$CHROME_BIN"
  rm -f "$ZIP"
fi

# 2) puppeteer-core (para manejar el navegador) ----------------------------
# puppeteer-core NO descarga ningún navegador propio (usamos el de arriba).
# TOOLS_DIR es un "proyecto" aislado (package.json propio + --prefix) para que
# npm instale SIEMPRE en $TOOLS_DIR/node_modules y no deduplique hacia un
# node_modules ancestro.
if [ ! -d "$TOOLS_DIR/node_modules/puppeteer-core" ]; then
  echo "[session-start] Instalando puppeteer-core…"
  mkdir -p "$TOOLS_DIR"
  [ -f "$TOOLS_DIR/package.json" ] || echo '{"name":"arbor-test-tools","private":true}' > "$TOOLS_DIR/package.json"
  npm install --prefix "$TOOLS_DIR" --no-audit --no-fund puppeteer-core@23 >/dev/null 2>&1
fi

# 3) Exponer rutas a la sesión ---------------------------------------------
{
  echo "export PUPPETEER_EXECUTABLE_PATH=\"$CHROME_BIN\""
  echo "export CHROME_HEADLESS_SHELL=\"$CHROME_BIN\""
  echo "export NODE_PATH=\"$TOOLS_DIR/node_modules\""
} >> "$CLAUDE_ENV_FILE"

echo "[session-start] Navegador headless listo: $CHROME_BIN"
