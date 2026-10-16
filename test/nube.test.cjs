// test/nube.test.cjs — Prueba de punta a punta de la sincronización con Supabase.
//
// Simula varios dispositivos (contextos de navegador aislados, cada uno con su
// propio IndexedDB) contra un proyecto de Supabase REAL con el esquema de
// supabase/migrations aplicado. Verifica: subida y bajada, fotos, edición,
// conflicto (gana la versión más nueva), borrado propagado, permisos por rol,
// trabajo sin conexión y la oferta de subir fichas locales al primer ingreso.
//
// Requiere usuarios de prueba ya confirmados (ver supabase/README.md):
//   NUBE_RELEV1=email:pass  NUBE_RELEV2=email:pass  NUBE_CONSULTA=email:pass
// Opcionales: NUBE_URL, NUBE_KEY (por defecto, los de NUBE_DEFAULT en index.html),
//             NUBE_PROXY (p.ej. http://127.0.0.1:44333 si el entorno usa proxy).
//
// Uso:  NUBE_RELEV1=... NUBE_RELEV2=... NUBE_CONSULTA=... node test/nube.test.cjs
//
// Deja fichas de prueba (borradas lógicamente) en el servidor: usar un proyecto de prueba.

const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8720 + (process.pid % 200);
const puppeteer = require('puppeteer-core');
const EXEC = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_HEADLESS_SHELL;

function cred(name) {
  const v = process.env[name] || '';
  const i = v.indexOf(':');
  if (i < 0) { console.error('Falta ' + name + '=email:contraseña'); process.exit(2); }
  return { email: v.slice(0, i), pass: v.slice(i + 1) };
}
const RELEV1 = cred('NUBE_RELEV1'), RELEV2 = cred('NUBE_RELEV2'), CONSULTA = cred('NUBE_CONSULTA');

let allOk = true;
const check = (name, ok, extra) => {
  if (!ok) allOk = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

const RUN = 'e2e' + Date.now().toString(36);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const args = ['--no-sandbox', '--disable-dev-shm-usage'];
  if (process.env.NUBE_PROXY) args.push('--proxy-server=' + process.env.NUBE_PROXY);
  const browser = await puppeteer.launch({ executablePath: EXEC, args });

  async function dispositivo(nombre) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log('  [' + nombre + ' pageerror] ' + (e.message || e)));
    page.on('dialog', d => d.dismiss());
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.db && typeof nubeSync === 'function', { timeout: 20000 });
    if (process.env.NUBE_URL) {
      await page.evaluate((url, key) => localStorage.setItem('arborrisk_nube_cfg', JSON.stringify({ url, key, nombre: 'Test' })),
        process.env.NUBE_URL, process.env.NUBE_KEY);
    }
    return page;
  }
  const login = (page, c) => page.evaluate(async (e, p) => { await nubeIngresar(e, p); await nubeSync(); return nubePerfil().rol; }, c.email, c.pass);
  const sync = page => page.evaluate(async () => { await nubeSync(); return { estado: nubeEstado.estado, error: nubeEstado.error, pend: await idbCount(OUTBOX) }; });
  const getRec = (page, id) => page.evaluate(id => { const r = records.find(x => x.id === id); return r ? JSON.parse(JSON.stringify(r)) : null; }, id);

  try {
    const A = await dispositivo('A'), B = await dispositivo('B');

    // ── 1. A crea un árbol con foto y una evaluación vinculada, y sube ──
    check('A ingresa como relevador', (await login(A, RELEV1)) === 'relevador');
    const ids = await A.evaluate(async (RUN, PNG) => {
      const bin = atob(PNG), arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const fotoId = 'photo_' + RUN + '_1';
      await dbPutPhoto(fotoId, new Blob([arr], { type: 'image/png' }));
      const now = new Date().toISOString();
      const reg = { id: RUN + '-reg', tipo: 'registro', code: 'REG-E2E-' + RUN, especie: 'Tipuana tipu', gps: '-31.41, -64.18',
        registroPhotos: [{ id: fotoId, caption: 'frente' }], updatedAt: now };
      const ev = { id: RUN + '-ev', code: 'ARB-E2E-' + RUN, especie: 'Tipuana tipu', arbolId: reg.id, riskLevel: 'mod', fecha: '2026-10-01', updatedAt: now };
      for (const r of [reg, ev]) { await dbPut(r); records.push(r); }
      return { reg: reg.id, ev: ev.id, foto: fotoId };
    }, RUN, PNG);
    let st = await sync(A);
    check('A sube todo (cola vacía, sin error)', st.estado === 'ok' && st.pend === 0, JSON.stringify(st));

    // ── 2. B baja todo, incluida la foto ──
    check('B ingresa como relevador', (await login(B, RELEV2)) === 'relevador');
    const bReg = await getRec(B, ids.reg), bEv = await getRec(B, ids.ev);
    check('B recibe árbol y evaluación vinculada', !!bReg && !!bEv && bEv.arbolId === ids.reg);
    const fotoB = await B.evaluate(async id => { const u = await resolvePhotoUrl(id); return !!u && !!(await dbGetPhoto(id)); }, ids.foto);
    check('B descarga la foto desde la nube', fotoB);

    // ── 3. Edición en B llega a A ──
    await B.evaluate(async id => {
      const r = records.find(x => x.id === id);
      r.observaciones = 'editado en B'; r.updatedAt = new Date().toISOString();
      await dbPut(r);
    }, ids.reg);
    await sync(B); await sync(A);
    check('Edición de B llega a A', ((await getRec(A, ids.reg)) || {}).observaciones === 'editado en B');

    // ── 4. Conflicto: A edita con hora anterior, B con posterior; B sube primero ──
    const t0 = Date.now();
    await A.evaluate(async (id, t) => {
      const r = records.find(x => x.id === id);
      r.riskLevel = 'low'; r.updatedAt = new Date(t - 10000).toISOString(); await dbPut(r);
    }, ids.ev, t0);
    await B.evaluate(async (id, t) => {
      const r = records.find(x => x.id === id);
      r.riskLevel = 'high'; r.updatedAt = new Date(t - 5000).toISOString(); await dbPut(r);
    }, ids.ev, t0);
    await sync(B);
    const confA = await A.evaluate(async () => { await nubeSync(); return nubeEstado.conflictos; });
    const aEv = await getRec(A, ids.ev);
    check('Conflicto: gana la versión más nueva (B) también en A', aEv.riskLevel === 'high' && confA === 1, 'A=' + aEv.riskLevel + ' conflictos=' + confA);

    // ── 5. Un relevador no puede borrar lo que cargó otro: se restaura ──
    await B.evaluate(async id => { await dbDelete(id); records = records.filter(r => r.id !== id); }, ids.reg);
    st = await sync(B);
    const restaurado = await getRec(B, ids.reg);
    check('Relevador 2 no borra ficha de relevador 1 (se restaura)', !!restaurado && st.pend === 0);

    // ── 5b. Reloj adelantado en otro dispositivo: un cambio posterior igual gana ──
    await B.evaluate(async id => {
      const r = records.find(x => x.id === id);
      r.observaciones = 'reloj adelantado'; r.updatedAt = new Date(Date.now() + 3600000).toISOString(); await dbPut(r);
    }, ids.reg);
    await sync(B); await sync(A);
    await A.evaluate(async id => {
      const r = records.find(x => x.id === id);
      r.observaciones = 'editado en B';
      r.updatedAt = marcaTiempo(r.updatedAt);   // lo mismo que hacen saveRecord/saveRegistroRecord
      await dbPut(r);
    }, ids.reg);
    await sync(A); await sync(B);
    check('Reloj adelantado: la edición posterior igual gana', ((await getRec(B, ids.reg)) || {}).observaciones === 'editado en B');

    // ── 6. Borrado del autor se propaga ──
    await A.evaluate(async id => { await dbDelete(id); records = records.filter(r => r.id !== id); }, ids.ev);
    await sync(A); await sync(B);
    check('Borrado de A se propaga a B', (await getRec(B, ids.ev)) === null);

    // ── 7. Sin conexión: queda en cola y sube al volver la señal ──
    await A.setOfflineMode(true);
    await A.evaluate(async RUN => {
      const r = { id: RUN + '-off', tipo: 'registro', code: 'REG-OFF-' + RUN, especie: 'Ceibo', updatedAt: new Date().toISOString() };
      await dbPut(r); records.push(r);
      window.dispatchEvent(new Event('offline'));
    }, RUN);
    const pendOff = await A.evaluate(async () => { await nubeSync(); return idbCount(OUTBOX); });
    check('Offline: el cambio queda en cola', pendOff === 1, pendOff + ' pendiente(s)');
    await A.setOfflineMode(false);
    await A.evaluate(() => window.dispatchEvent(new Event('online')));
    await A.waitForFunction(async () => (await idbCount(OUTBOX)) === 0 && nubeEstado.estado === 'ok', { timeout: 20000 });
    await sync(B);
    check('Al volver la conexión sube solo y llega a B', !!(await getRec(B, RUN + '-off')));

    // ── 8. Rol consulta: ve todo, no sube nada ──
    const C = await dispositivo('C');
    check('C ingresa como consulta', (await login(C, CONSULTA)) === 'consulta');
    check('Consulta ve las fichas del equipo', !!(await getRec(C, ids.reg)));
    await C.evaluate(async id => { const r = records.find(x => x.id === id); r.observaciones = 'NO DEBE SUBIR'; r.updatedAt = new Date().toISOString(); await dbPut(r); }, ids.reg);
    await sync(C); await sync(A);
    check('Lo que edita un usuario de consulta no llega al servidor', ((await getRec(A, ids.reg)) || {}).observaciones === 'editado en B');

    // ── 9. Primer ingreso con fichas locales: ofrece subirlas ──
    const D = await dispositivo('D');
    await D.evaluate(async RUN => {
      const r = { id: RUN + '-loc', tipo: 'registro', code: 'REG-LOC-' + RUN, especie: 'Jacaranda mimosifolia', updatedAt: new Date().toISOString() };
      await dbPut(r); records.push(r);   // sin sesión: no se encola
    }, RUN);
    await D.evaluate(async (e, p) => { await nubeIngresar(e, p); }, RELEV1.email, RELEV1.pass);
    await D.waitForFunction(() => document.getElementById('confirm-modal').classList.contains('open'), { timeout: 10000 });
    await D.click('#confirm-ok-btn');
    await new Promise(r => setTimeout(r, 800));
    await D.waitForFunction(async () => (await idbCount(OUTBOX)) === 0 && nubeEstado.estado === 'ok', { timeout: 20000 });
    await sync(B);
    check('Primer ingreso: ofrece subir las fichas locales y las sube', !!(await getRec(B, RUN + '-loc')));

    // ── 10. UI: indicador y modal ──
    const ui = await A.evaluate(async () => {
      openNubeModal();
      await nubeSync();
      return { dot: document.getElementById('nube-dot').className, txt: document.getElementById('nube-body').textContent };
    });
    check('Indicador verde y modal con estado', /\bok\b/.test(ui.dot) && /Sincronizado/.test(ui.txt), ui.dot);

    // Limpieza: borrar (lógicamente) lo creado por este test
    await A.evaluate(async RUN => {
      for (const r of records.filter(x => x.id.startsWith(RUN))) await dbDelete(r.id);
      await nubeSync();
    }, RUN);
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
