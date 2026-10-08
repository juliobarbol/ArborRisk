// test/data.test.cjs — Datos del usuario: backup, restauración y escapado.
//
// Simula dos "teléfonos" (contextos de navegador separados) y verifica:
//  - el texto con < & " se muestra literal y no ejecuta código (esc());
//  - el backup completo incluye TODAS las fotos (incluidas las de Ficha de
//    Registro) y al restaurarlo en un teléfono vacío vuelven como fotos;
//  - restaurar guarda una copia previa y "Deshacer" la recupera con fotos;
//  - un archivo dañado o con IDs raros no toca nada;
//  - "Consolidar" también recupera fotos de registro;
//  - el recordatorio de backup (7 días, posponer 1 día).
//
// Uso: node test/data.test.cjs   (requisitos: ver test/pwa.test.cjs)
const puppeteer = require('puppeteer-core'); const {spawn}=require('child_process'); const path=require('path');
const ROOT=path.resolve(__dirname,'..'), PORT=8700 + (process.pid % 200);
const srv=spawn('python3',['-m','http.server',String(PORT),'--bind','127.0.0.1'],{cwd:ROOT,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ok=true; const check=(n,c,x)=>{ if(!c) ok=false; console.log((c?'PASS':'FAIL')+'  '+n+(x?'  — '+x:'')); };
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
async function open(ctx){ const p=await ctx.newPage(); p.on('pageerror',()=>{}); p.on('dialog',d=>d.dismiss());
  await p.goto(`http://127.0.0.1:${PORT}/index.html`,{waitUntil:'domcontentloaded'}); await p.waitForFunction(()=>typeof records!=='undefined' && typeof db!=='undefined' && db!==null,{timeout:15000}); await sleep(500); return p; }
async function importFile(p, fn, json){ // simula elegir archivo + confirmar
  await p.evaluate((fn,json)=>{ const f=new File([json],'b.json',{type:'application/json'}); window[fn]({files:[f],value:''}); }, fn, json);
  await sleep(400);
  const open=await p.evaluate(()=>document.getElementById('confirm-modal').classList.contains('open'));
  if(open) await p.evaluate(()=>document.getElementById('confirm-ok-btn').click());
  await sleep(1500);
}
(async()=>{ await sleep(800);
 const b=await puppeteer.launch({executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:['--no-sandbox']});
 // ---------- Teléfono A ----------
 const A=await b.createBrowserContext(); let p=await open(A);
 await p.evaluate(async(PNG)=>{
   await dbPutPhoto('photo_1_aaa', dataUrlToBlob(PNG)); await dbPutPhoto('photo_2_bbb', dataUrlToBlob(PNG)); await dbPutPhoto('photo_3_ccc', dataUrlToBlob(PNG));
   await dbPut({id:'1000', code:'ARB-JUL-0001', especie:'Tipa <i>x</i>', cliente:'Muni & Cía', fecha:'2026-01-10', riskLevel:'high', observaciones:'DAP < 30 & "raro"', plagas:'<img src=x onerror="window.__pwn=1">', photos:['photo_1_aaa'], evaluaciones:[{fecha:'2025-01-01', photos:['photo_2_bbb']}], updatedAt:'2026-01-10T10:00:00Z'});
   await dbPut({id:'2000', tipo:'registro', code:'REG-JUL-0001', especie:'Jacarandá', observaciones:'<b>negrita</b>', registroPhotos:[{id:'photo_3_ccc', caption:'tronco <base>'}], updatedAt:'2026-01-11T10:00:00Z'});
   localStorage.removeItem('arborrisk_last_backup'); localStorage.removeItem('arborrisk_backup_snooze');
 }, PNG);
 await p.reload({waitUntil:'domcontentloaded'}); await p.waitForFunction(()=>records && records.length===2,{timeout:15000}); await sleep(500);
 // escapado
 await p.evaluate(()=>openDetail('1000')); await sleep(600);
 let t=await p.evaluate(()=>({txt:document.getElementById('detail-body').textContent, pwn:!!window.__pwn, imgs:document.querySelectorAll('#detail-body img[src="x"]').length}));
 check('Texto con < & " se ve literal en el detalle', t.txt.includes('<img src=x onerror') && t.txt.includes('Muni & Cía'), '');
 check('Texto malicioso no ejecuta código', !t.pwn && t.imgs===0);
 await p.evaluate(()=>closeDetail()); await p.evaluate(()=>openDetail('2000')); await sleep(600);
 t=await p.evaluate(()=>document.getElementById('detail-body').textContent);
 check('Registro: observación <b> se ve literal', t.includes('<b>negrita</b>'));
 let card=await p.evaluate(()=>document.body.innerText.includes('Tipa <i>x</i>'));
 check('Tarjeta de la lista muestra la especie literal', card);
 // recordatorio: fichas de enero, nunca respaldado → visible
 let ban=await p.evaluate(()=>({d:getComputedStyle(document.getElementById('backup-banner')).display, t:document.getElementById('backup-banner-text').textContent}));
 check('Recordatorio visible si nunca se hizo backup', ban.d==='flex', ban.t);
 // export
 const json=await p.evaluate(async()=>{ let href=null; const orig=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){href=this.href}; await exportData(); HTMLAnchorElement.prototype.click=orig; return await (await fetch(href)).text(); });
 const data=JSON.parse(json); const reg=data.find(r=>r.id==='2000'), rk=data.find(r=>r.id==='1000');
 check('Backup incluye foto de Ficha de Registro', reg.registroPhotos[0].id.startsWith('data:image'), reg.registroPhotos[0].caption);
 check('Backup incluye fotos de evaluación e historial', rk.photos[0].startsWith('data:') && rk.evaluaciones[0].photos[0].startsWith('data:'));
 ban=await p.evaluate(()=>getComputedStyle(document.getElementById('backup-banner')).display);
 check('Recordatorio se oculta tras el backup', ban==='none');
 await p.evaluate(()=>{ localStorage.setItem('arborrisk_last_backup', new Date(Date.now()-9*86400000).toISOString()); checkBackupReminder(); });
 ban=await p.evaluate(()=>({d:getComputedStyle(document.getElementById('backup-banner')).display, t:document.getElementById('backup-banner-text').textContent}));
 check('Recordatorio a los 9 días', ban.d==='flex' && ban.t.includes('9 días'), ban.t);
 await p.evaluate(()=>snoozeBackupReminder()); ban=await p.evaluate(()=>getComputedStyle(document.getElementById('backup-banner')).display);
 check('"Más tarde" lo oculta hasta mañana', ban==='none');
 // ---------- Teléfono B (nuevo, vacío) ----------
 const B=await b.createBrowserContext(); p=await open(B);
 check('Teléfono nuevo arranca vacío', await p.evaluate(()=>records.length===0));
 await importFile(p,'importData',json);
 let st=await p.evaluate(async()=>{ const r=records.find(x=>x.id==='2000'); const id=r.registroPhotos[0].id; const blob=await dbGetPhoto(id); const rk=records.find(x=>x.id==='1000'); const ids=await dbGetAllPhotoIds();
   return {n:records.length, id, blob:!!blob, cap:r.registroPhotos[0].caption, rkId:rk.photos[0], evId:rk.evaluaciones[0].photos[0], nPhotos:ids.filter(i=>i.startsWith('photo_')).length, stored:(await dbGetAll()).length}; });
 check('Restaurado en teléfono nuevo: 2 fichas', st.n===2 && st.stored===2);
 check('Foto de registro recuperada y guardada como foto', st.id.startsWith('photo_') && st.blob, st.cap);
 check('Fotos de evaluación/historial guardadas como fotos', st.rkId.startsWith('photo_') && st.evId.startsWith('photo_') && st.nPhotos===3, 'fotos='+st.nPhotos);
 // persistencia tras recargar
 await p.reload({waitUntil:'domcontentloaded'}); await p.waitForFunction(()=>records && records.length===2,{timeout:15000}); await sleep(500);
 st=await p.evaluate(async()=>{ const r=records.find(x=>x.id==='2000'); return !!(await dbGetPhoto(r.registroPhotos[0].id)); });
 check('Tras recargar, la foto de registro sigue', st);
 // ---------- restaurar encima de datos + deshacer ----------
 await p.evaluate(async()=>{ await dbPut({id:'3000', code:'ARB-JUL-0099', especie:'Ceibo', updatedAt:new Date().toISOString()}); records=await dbGetAll(); });
 const other=JSON.stringify([{id:'9000', code:'X-1', especie:'Otro'}]);
 await importFile(p,'importData',other);
 st=await p.evaluate(async()=>({n:records.length, snap:!!(await dbGetSnapshot()), ids:(await dbGetAllPhotoIds()).filter(i=>i.startsWith('photo_')).length}));
 check('Restaurar reemplaza y guarda copia previa', st.n===1 && st.snap, 'fotos conservadas='+st.ids);
 check('Las fotos de la copia previa no se borran', st.ids===3);
 await p.evaluate(()=>openSyncMenu()); await sleep(400);
 let undo=await p.evaluate(()=>({d:document.getElementById('undo-restore-btn').style.display, t:document.getElementById('undo-restore-btn').textContent}));
 check('Botón "Deshacer última restauración" aparece', undo.d==='', undo.t);
 await p.evaluate(()=>closeSyncMenu());
 await p.evaluate(()=>undoLastRestore()); await sleep(400); await p.evaluate(()=>document.getElementById('confirm-ok-btn').click()); await sleep(1500);
 st=await p.evaluate(async()=>{ const r=records.find(x=>x.id==='2000'); return {n:records.length, ids:records.map(r=>r.id).sort().join(','), photo:r?!!(await dbGetPhoto(r.registroPhotos[0].id)):false, snap:!!(await dbGetSnapshot()), stored:(await dbGetAll()).length}; });
 check('Deshacer vuelve a las 3 fichas previas con fotos', st.n===3 && st.stored===3 && st.photo && !st.snap, st.ids);
 // ---------- archivo inválido no toca nada ----------
 await importFile(p,'importData','{esto no es json');
 st=await p.evaluate(async()=>({n:records.length, stored:(await dbGetAll()).length, toast:document.getElementById('toast')?document.getElementById('toast').textContent:''}));
 check('Archivo dañado: no se borra nada', st.n===3 && st.stored===3, st.toast);
 await importFile(p,'importData',JSON.stringify([{id:"x');alert(1);//"}]));
 st=await p.evaluate(async()=>(await dbGetAll()).length);
 check('Archivo con IDs raros se rechaza sin tocar nada', st===3);
 // ---------- consolidar (merge) con foto de registro ----------
 const C=await b.createBrowserContext(); p=await open(C);
 const campo=JSON.stringify({_arborrisk_export:true,_version:1,_inspector:'Ana <x>',records:data});
 await importFile(p,'mergeImportData',campo);
 st=await p.evaluate(async()=>{ const r=records.find(x=>x.id==='2000'); return {n:records.length, id:r&&r.registroPhotos[0].id, blob:r?!!(await dbGetPhoto(r.registroPhotos[0].id)):false, meta:document.getElementById('merge-result-body').textContent}; });
 check('Consolidar: foto de registro guardada como foto', st.n===2 && st.id.startsWith('photo_') && st.blob);
 check('Consolidar: nombre del inspector se muestra literal', st.meta.includes('Ana <x>'));
 await b.close(); srv.kill(); console.log(ok?'\n✓ TODO OK':'\n✗ HUBO FALLOS'); process.exit(ok?0:1);
})().catch(e=>{console.error(e); srv.kill(); process.exit(1)});
