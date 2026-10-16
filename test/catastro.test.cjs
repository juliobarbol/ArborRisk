// test/catastro.test.cjs — Test de comportamiento de las mejoras para catastro.
//
// Verifica, en un navegador headless real:
//   - Consolidar un JSON con fichas maliciosas NO ejecuta código (XSS) en
//     lista, detalle, mapa/proyectos, catastro ni en el resultado del merge.
//   - Las fichas con ID inválido se descartan al consolidar.
//   - La lista se pagina (60 por página + botón "Mostrar más").
//   - Las fichas nuevas usan UUID y guardan autoría y precisión/fuente del GPS;
//     editar las coordenadas a mano las marca como 'manual'.
//   - El CSV incluye todas las fichas, con ';' y coma decimal, y neutraliza fórmulas.
//   - El GeoJSON usa el inspector de cada ficha (no el del dispositivo que exporta).
//
// Requisitos: los mismos que test/pwa.test.cjs (SessionStart hook).
// Uso:  node test/catastro.test.cjs

const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8620 + (process.pid % 200);

let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  console.error('No se encontró puppeteer-core. Corré el SessionStart hook primero.');
  process.exit(2);
}
const EXEC = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_HEADLESS_SHELL;
if (!EXEC) { console.error('Falta $PUPPETEER_EXECUTABLE_PATH.'); process.exit(2); }

let allOk = true;
const check = (name, ok, extra) => {
  if (!ok) allOk = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const browser = await puppeteer.launch({ executablePath: EXEC, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
    page.on('dialog', d => d.dismiss());
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => typeof window.mergeImportData === 'function' && window.db, { timeout: 15000 });

    // Capturar descargas (CSV / GeoJSON) sin disparar el diálogo de descarga
    await page.evaluate(() => {
      window.__blobs = [];
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { window.__blobs.push(b); return orig(b); };
      HTMLAnchorElement.prototype.click = function() {};
      localStorage.setItem('arborrisk_config', JSON.stringify({ nombre: 'Exportador', iniciales: 'EXP', proyecto: 'Test' }));
    });

    // ── 1. Consolidar archivo con fichas maliciosas + 150 fichas normales ──
    const XSS = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
    const now = new Date().toISOString();
    const incoming = [
      { id: 'evil1', code: '<svg onload="window.__xss=99">', especie: XSS, cliente: XSS, fecha: '2026-01-01',
        gps: '-31.4, -64.1', riskLevel: 'high', defRaices: [XSS], tratamiento: [XSS], photos: ['x" onerror="window.__xss=7'],
        trabajos: [{ tipo: XSS, descripcion: XSS, responsable: XSS }], updatedAt: now },
      { id: "bad');window.__xss=3;//", code: 'ARB-BAD-0001', especie: 'Malo', updatedAt: now },
      { id: 'reg1', tipo: 'registro', code: 'REG-ZZZ-0001', especie: 'Tilia', inspector: 'Ana Pérez',
        gps: '-31.5, -64.2', barrio: '=HYPERLINK("http://x")', dap: '35.5', updatedAt: now },
    ];
    for (let i = 0; i < 150; i++) {
      incoming.push({ id: 'n' + i, code: 'ARB-NNN-' + String(i).padStart(4, '0'), especie: 'Fraxinus', updatedAt: now });
    }
    const payload = { _arborrisk_export: true, _inspector: XSS, _iniciales: 'ZZZ', _proyecto: XSS, records: incoming };

    await page.evaluate(async (json) => {
      const file = new File([json], 'campo.json', { type: 'application/json' });
      mergeImportData({ files: [file], value: '' });
    }, JSON.stringify(payload));
    await page.waitForFunction(() => document.getElementById('merge-modal').classList.contains('open'), { timeout: 15000 });

    const merged = await page.evaluate(() => ({
      ids: records.map(r => r.id),
      cards: document.querySelectorAll('#list-container .arb-card').length,
      more: (document.querySelector('#list-container .list-more') || {}).textContent || '',
    }));
    check('ID inválido descartado al consolidar', !merged.ids.includes("bad');window.__xss=3;//"));
    check('Fichas válidas consolidadas', merged.ids.includes('evil1') && merged.ids.includes('reg1') && merged.ids.length === 152,
      merged.ids.length + ' fichas');
    check('Lista paginada a 60 tarjetas', merged.cards === 60, merged.cards + ' tarjetas');
    check('Botón "Mostrar más" presente', /92 restantes de 152/.test(merged.more), merged.more);

    await page.evaluate(() => listShowMore());
    const cards2 = await page.evaluate(() => document.querySelectorAll('#list-container .arb-card').length);
    check('"Mostrar más" agrega otra página', cards2 === 120, cards2 + ' tarjetas');

    // ── 2. Renderizar todas las vistas con la ficha maliciosa ──
    await page.evaluate(async () => {
      document.getElementById('search-input').value = '';
      applyFilters();
      await openDetail('evil1');
      renderProjects();
      renderCatastro();
      const ac = document.getElementById('f-especie');
      saveAutocompleteValue('especies', '<b onmouseover=x>Tipa</b>');
      ac.value = 'ti';
      autocompleteInput('f-especie', 'especies');
    });
    await new Promise(r => setTimeout(r, 600));
    const xss = await page.evaluate(() => ({
      flag: window.__xss,
      literal: document.getElementById('detail-body').textContent.includes('<img src=x'),
      cardLiteral: Array.from(document.querySelectorAll('.card-species')).some(e => e.textContent.includes('<img src=x')),
      injected: document.querySelectorAll('img[src="x"], svg[onload], b[onmouseover]').length,
    }));
    check('Ningún payload XSS se ejecutó', xss.flag === undefined, 'window.__xss=' + xss.flag);
    check('No se inyectaron elementos del payload', xss.injected === 0, xss.injected + ' elementos');
    check('El texto malicioso se muestra literal (escapado)', xss.literal && xss.cardLiteral);

    // ── 3. Ficha nueva: UUID, autoría y metadatos de GPS ──
    await page.evaluate(() => {
      navigator.geolocation.getCurrentPosition = (ok) => ok({ coords: { latitude: -31.416798, longitude: -64.183418, accuracy: 8.4 } });
    });
    const created = await page.evaluate(async () => {
      openForm();
      document.getElementById('f-especie').value = 'Jacaranda mimosifolia';
      captureGPS();
      await saveRecord();
      const r = records.find(x => x.especie === 'Jacaranda mimosifolia');
      return r && { id: r.id, gpsFuente: r.gpsFuente, gpsPrecision: r.gpsPrecision, creadoPor: r.creadoPor, deviceId: r.deviceId };
    });
    check('ID nuevo es UUID', !!created && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(created.id), created && created.id);
    check('Guarda fuente y precisión del GPS', !!created && created.gpsFuente === 'gps' && created.gpsPrecision === 8,
      created && (created.gpsFuente + ' ±' + created.gpsPrecision));
    check('Guarda autoría', !!created && created.creadoPor === 'Exportador' && /^dev_/.test(created.deviceId || ''));

    const edited = await page.evaluate(async (id) => {
      openForm(id);
      document.getElementById('gps-display').value = '-31.5, -64.2';
      await saveRecord();
      const r = records.find(x => x.id === id);
      return { gpsFuente: r.gpsFuente, gpsPrecision: r.gpsPrecision, creadoPor: r.creadoPor };
    }, created && created.id);
    check('Edición manual de coordenadas → fuente "manual"', edited.gpsFuente === 'manual' && edited.gpsPrecision === null);
    check('La autoría original se conserva al editar', edited.creadoPor === 'Exportador');

    // ── 4. CSV ──
    // Blob.text() descarta el BOM al decodificar: se verifica sobre los bytes
    const csvOut = await page.evaluate(async () => {
      window.__blobs = [];
      exportCSV();
      const bytes = new Uint8Array(await window.__blobs[0].arrayBuffer());
      return { text: await window.__blobs[0].text(), bom: bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF };
    });
    const csvLines = csvOut.text.replace(/^﻿/, '').split('\r\n');
    const header = csvLines[0].split(';');
    const regLine = csvLines.find(l => l.includes('REG-ZZZ-0001')) || '';
    const cells = regLine.split(';');
    check('CSV con BOM y todas las fichas', csvOut.bom && csvLines.length === 1 + 153, (csvLines.length - 1) + ' filas');
    check('CSV usa coma decimal', cells[header.indexOf('dap_cm')] === '35,5' && cells[header.indexOf('latitud')] === '-31,5',
      cells[header.indexOf('dap_cm')] + ' / ' + cells[header.indexOf('latitud')]);
    check('CSV neutraliza fórmulas', regLine.includes('"\'=HYPERLINK'));
    check('CSV usa el inspector de la ficha', cells[header.indexOf('inspector')] === '"Ana Pérez"');

    // ── 5. GeoJSON ──
    const gj = await page.evaluate(async () => {
      window.__blobs = [];
      exportGeoJSON();
      return JSON.parse(await window.__blobs[0].text());
    });
    const regFeat = gj.features.find(f => f.properties.codigo === 'REG-ZZZ-0001');
    const evilFeat = gj.features.find(f => f.properties.especie && f.properties.especie.includes('<img'));
    check('GeoJSON: inspector de la ficha, no del exportador', regFeat && regFeat.properties.inspector === 'Ana Pérez'
      && evilFeat && evilFeat.properties.inspector !== 'Exportador', regFeat && regFeat.properties.inspector);
    check('GeoJSON: incluye precisión y fuente GPS', gj.features.some(f => f.properties.gps_fuente === 'manual'));

    const relevantErrors = pageErrors.filter(e => !/jspdf|L is not defined|Leaflet|QRCode|markerCluster|cdnjs/i.test(e));
    check('Sin errores de JS propios', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));
  } catch (e) {
    allOk = false;
    console.error('ERROR', e);
  } finally {
    await browser.close();
    srv.kill();
  }
  console.log(allOk ? '\n✓ TODOS LOS CHECKS OK' : '\n✗ HAY FALLOS');
  process.exit(allOk ? 0 : 1);
})();
