// test/pwa.test.cjs — Test de PWA con navegador headless real.
//
// Sirve para las apps de un solo index.html (ArborRisk / Presupuestos).
// Verifica: Service Worker real (./sw.js), que controla la página, que crea
// la cache de la versión declarada en sw.js, y que el app-shell carga OFFLINE.
// Si la app expone `downloadMapArea`/`lngLatToTile` (ArborRisk), valida además
// el mecanismo de descarga de zona (CACHE_TILES) y la matemática de tiles.
//
// Requisitos (los deja listos el SessionStart hook .claude/hooks/session-start.sh):
//   - $PUPPETEER_EXECUTABLE_PATH → binario chrome-headless-shell
//   - $NODE_PATH → node_modules con puppeteer-core
//
// Uso:  node test/pwa.test.cjs
//
// Nota: en el entorno remoto, la network policy puede bloquear cdnjs y los
// tiles de OSM; por eso este test NO depende de recursos externos (usa solo
// archivos locales y URLs same-origin para ejercitar el mecanismo de tiles).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8420 + (process.pid % 200);

let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  console.error('No se encontró puppeteer-core. Corré el SessionStart hook primero\n' +
    '(.claude/hooks/session-start.sh) o seteá NODE_PATH a su node_modules.');
  process.exit(2);
}
const EXEC = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_HEADLESS_SHELL;
if (!EXEC) {
  console.error('Falta $PUPPETEER_EXECUTABLE_PATH (lo setea el SessionStart hook).');
  process.exit(2);
}

// Versión de cache declarada en sw.js
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const m = swSrc.match(/CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/);
const CACHE_VERSION = m && m[1];

let allOk = true;
const check = (name, ok, extra) => {
  if (!ok) allOk = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));

  const browser = await puppeteer.launch({
    executablePath: EXEC,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', () => {}); // ignorar errores de libs externas bloqueadas
    const base = `http://localhost:${PORT}/index.html`;
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // SW activo y controlando la página (puede requerir un reload)
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    }

    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return {
        controller: !!navigator.serviceWorker.controller,
        scriptURL: (reg && reg.active && reg.active.scriptURL) || '',
        caches: await caches.keys(),
        hasTileDownload: typeof window.downloadMapArea === 'function'
          && typeof window.lngLatToTile === 'function',
      };
    });
    check('SW controla la página', info.controller);
    check('SW es ./sw.js (archivo real, no blob:)', /\/sw\.js$/.test(info.scriptURL));
    check(`Cache de versión "${CACHE_VERSION}" creada`,
      !!CACHE_VERSION && info.caches.includes(CACHE_VERSION), 'caches: ' + info.caches.join(', '));

    // Funcionalidad de descarga de zona (solo ArborRisk)
    if (info.hasTileDownload) {
      const dl = await page.evaluate(() => new Promise((resolve) => {
        const urls = ['./icon.svg', './manifest.webmanifest', './sw.js'];
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => { if (e.data && e.data.finished) resolve(e.data); };
        navigator.serviceWorker.controller.postMessage({ type: 'CACHE_TILES', urls }, [ch.port2]);
        setTimeout(() => resolve({ timeout: true }), 10000);
      }));
      check('CACHE_TILES descarga y reporta finished', dl.finished === true && dl.ok === dl.total);

      const math = await page.evaluate(() => {
        const t0 = window.lngLatToTile(0, 0, 0);
        const tBA = window.lngLatToTile(-58.3816, -34.6037, 12);
        const n = Math.pow(2, 12);
        return { t0, tBA, inRange: tBA.x >= 0 && tBA.x < n && tBA.y >= 0 && tBA.y < n };
      });
      check('lngLatToTile correcto', math.t0.x === 0 && math.t0.y === 0 && math.inRange,
        `BA z12 → ${math.tBA.x}/${math.tBA.y}`);
    }

    // OFFLINE: cortar red y recargar → el app-shell debe seguir cargando
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    const off = await page.evaluate(() => ({
      title: document.title,
      bodyLen: document.body ? document.body.innerHTML.length : 0,
    }));
    await page.setOfflineMode(false);
    check('Offline: el documento carga desde cache', off.title.length > 0 && off.bodyLen > 500,
      `título="${off.title}"`);

  } finally {
    await browser.close();
    srv.kill();
  }

  console.log(allOk ? '\n✓ TODOS LOS CHECKS OK' : '\n✗ HUBO FALLOS');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error('ERROR', e && e.stack || e); process.exit(1); });
