/* FocusFrame v5 — private local capture, two modes, no third-party services. */
'use strict';
const $ = id => document.getElementById(id);
const DB_NAME = 'focusframe-local-v1'; // Keep existing sessions when updating.
const SETTINGS_KEY = 'focusframe-settings-v1';
const MAX_FRAMES = 180;
const GYM_LIMIT_MS = 10 * 60 * 1000;
const CLIP_SECONDS = 30;
const preview = $('livePreview');
const captureCanvas = document.createElement('canvas');
let dbPromise;
let mode = 'timelapse';
let facing = 'user';
let previewStream = null;
let active = null;
let busy = false;
let switching = false;
let dimmed = false;
let dimTimer = null;
let tickTimer = null;
let sampleTimer = null;
let wakeLock = null;
let dialogUrl = null;
let currentDialogSession = null;
let thumbUrls = [];
let toastTimer = null;
let checkpointAt = 0;
let settings = {autoDim:true};
try {const stored=JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}');settings.autoDim=stored.autoDim !== false;} catch {}

function toast(message, duration=4400){
  $('toast').textContent=message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>$('toast').classList.remove('show'),duration);
}
function formatTime(ms){
  const t=Math.floor(Math.max(0,ms)/1000);
  return [Math.floor(t/3600),Math.floor(t%3600/60),t%60].map(x=>String(x).padStart(2,'0')).join(':');
}
function escapeHtml(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function dateKey(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
function delay(ms){return new Promise(r=>setTimeout(r,ms));}
function makeId(){return crypto.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;}

function openDB(){
  if(!('indexedDB' in window))return Promise.reject(new Error('Lokaler Speicher nicht verfügbar.'));
  if(!dbPromise) dbPromise=new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('sessions'))db.createObjectStore('sessions',{keyPath:'id'});
      if(!db.objectStoreNames.contains('frames'))db.createObjectStore('frames',{keyPath:['sid','n']}).createIndex('sid','sid');
      if(!db.objectStoreNames.contains('chunks'))db.createObjectStore('chunks',{keyPath:['sid','n']}).createIndex('sid','sid');
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error||new Error('Speicherzugriff fehlgeschlagen.'));
  }).catch(e=>{dbPromise=null;throw e;});
  return dbPromise;
}
async function dbPut(name,data){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction(name,'readwrite');tx.objectStore(name).put(data);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error('Speichern fehlgeschlagen.'));tx.onabort=()=>reject(tx.error||new Error('Speicher voll.'));});}
async function dbGet(name,key){const db=await openDB();return new Promise((resolve,reject)=>{const req=db.transaction(name,'readonly').objectStore(name).get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function dbAll(name,sid){const db=await openDB();return new Promise((resolve,reject)=>{const store=db.transaction(name,'readonly').objectStore(name);const req=sid===undefined?store.getAll():store.index('sid').getAll(IDBKeyRange.only(sid));req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function dbDelete(name,key){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction(name,'readwrite');tx.objectStore(name).delete(key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
async function deleteItems(name,sid,thin=false){
  const all=await dbAll(name,sid);
  if(!all.length)return 0;
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(name,'readwrite');const store=tx.objectStore(name);
    for(let i=0;i<all.length;i++)if(!thin||(i%2===1&&i!==all.length-1))store.delete([sid,all[i].n]);
    tx.oncomplete=()=>resolve(thin?all.filter((_,i)=>i%2===0||i===all.length-1).length:0);
    tx.onerror=()=>reject(tx.error);
  });
}
async function deleteSession(id){await deleteItems('frames',id);await deleteItems('chunks',id);await dbDelete('sessions',id);}

function chooseMime(){
  if(!window.MediaRecorder)return null;
  const possible=['video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm'];
  return possible.find(type=>MediaRecorder.isTypeSupported(type))||'';
}
function cameraError(error){
  if(error?.name==='NotAllowedError'||error?.name==='PermissionDeniedError')return 'Kamerazugriff nicht erlaubt. Bitte die Kamera in Safari freigeben.';
  if(error?.name==='NotFoundError')return 'Diese Kamera ist nicht verfügbar.';
  if(error?.name==='NotReadableError')return 'Kamera wird gerade von einer anderen App verwendet.';
  return error?.message||'Die Kamera konnte nicht geöffnet werden.';
}
function closeTracks(stream){if(stream)stream.getTracks().forEach(track=>track.stop());}
function setPreviewState(on){
  $('cameraStage').classList.toggle('ready',on);
  preview.classList.toggle('mirror',facing==='user');
  $('flipLabel').textContent=facing==='user'?'Selfie':'Rückseite';
}
async function openCamera(target=facing){
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Kamera nur über HTTPS/Safari verfügbar.');
  // iOS usually cannot open front and rear cameras simultaneously. Close first.
  if(previewStream){closeTracks(previewStream);previewStream=null;preview.pause();preview.srcObject=null;}
  setPreviewState(false);
  const common={width:{ideal:1280},height:{ideal:720},frameRate:{ideal:24,max:30}};
  let stream;
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{...common,facingMode:{exact:target}}});
  }catch(e){
    if(e.name!=='OverconstrainedError'&&e.name!=='NotFoundError')throw e;
    stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{...common,facingMode:{ideal:target}}});
  }
  try{
    const actualFacing=stream.getVideoTracks()[0]?.getSettings?.().facingMode;
    if(actualFacing && actualFacing!==target)throw new Error('Diese Kamerarichtung ist auf dem Gerät nicht verfügbar.');
    preview.srcObject=stream;
    preview.muted=true;
    await preview.play();
    if(!preview.videoWidth)await Promise.race([new Promise(r=>preview.addEventListener('loadedmetadata',r,{once:true})),delay(1400)]);
    facing=target;
    previewStream=stream;
    setPreviewState(true);
    return stream;
  }catch(e){closeTracks(stream);preview.srcObject=null;setPreviewState(false);throw e;}
}
async function flipCamera(){
  if(busy||switching)return;
  if(active?.mode==='video') {toast('Gym-Video: Kamera vor dem Start wechseln.');return;}
  switching=true;updateUI();
  const old=facing;
  try{
    await openCamera(facing==='user'?'environment':'user');
    if(active)active.stream=previewStream;
    toast(facing==='user'?'Frontkamera aktiv.':'Rückkamera aktiv.');
  }catch(e){
    toast(cameraError(e),6000);
    try{await openCamera(old);if(active)active.stream=previewStream;}catch{}
  }finally{switching=false;updateUI();}
}
async function activateCamera(){
  if(busy||switching||active)return;
  switching=true;updateUI();
  try{await openCamera();toast('Kamera bereit. Du kannst jetzt wechseln oder aufnehmen.');}
  catch(e){toast(cameraError(e),6500);}
  finally{switching=false;updateUI();}
}
function setMode(next){
  if(active||busy||switching)return;
  mode=next;
  document.querySelectorAll('.mode-btn').forEach(button=>{
    const selected=button.dataset.mode===next;
    button.classList.toggle('selected',selected);
    button.setAttribute('aria-pressed',String(selected));
  });
  $('previewInfo').textContent=next==='timelapse'?'30-Sekunden-Zeitraffer mit Timer':'Normales Video · max. 10 Minuten';
  $('modeExplanation').textContent=next==='timelapse'
    ? 'Speichersparend für lange Sessions: Einzelbilder statt stundenlangem Rohvideo. Export als etwa 30 Sekunden langer Clip mit sichtbarer Aufnahmezeit.'
    : 'Normales Video für deine Übungsausführung. Bis zu 10 Minuten pro Clip. Vor der Aufnahme Front- oder Rückkamera wählen.';
  updateUI();
}
function updateUI(){
  const recording=!!active;
  $('recordIndicator').hidden=!recording;
  $('captureStatus').textContent=busy&&recording?'SPEICHERN ...':recording?'AUFNAHME LÄUFT':switching?'KAMERA WECHSELT ...':'BEREIT ZUM START';
  $('startStop').disabled=busy||switching;
  $('startStop').classList.toggle('recording',recording);
  $('startLabel').textContent=busy&&recording?'Speichere Aufnahme ...':recording?'Beenden & speichern':'Aufnahme starten';
  $('buttonTail').textContent=recording?'STOP':'START';
  $('dimButton').disabled=!recording||busy;
  $('flipCamera').disabled=busy||switching||(recording&&active.mode==='video');
  $('activateCamera').disabled=busy||switching;
  $('sessionTitle').disabled=recording||busy;
  document.querySelectorAll('.mode-btn').forEach(b=>b.disabled=recording||busy||switching);
  $('previewInfo').textContent=recording
    ? (active.mode==='timelapse'?'Zeitraffer wird aufgezeichnet':'Gym-Video wird aufgezeichnet')
    :mode==='timelapse'?'30-Sekunden-Zeitraffer mit Timer':'Normales Video · max. 10 Minuten';
}
async function acquireWakeLock(){
  if(!active||document.visibilityState!=='visible'||!navigator.wakeLock||wakeLock)return;
  try{wakeLock=await navigator.wakeLock.request('screen');}catch{}
}
async function releaseWakeLock(){if(wakeLock){const old=wakeLock;wakeLock=null;try{await old.release();}catch{}}}
function durationOf(a=active){return a?Math.max(0,Date.now()-a.startedAt-a.pausedMs-(a.pausedAt?Date.now()-a.pausedAt:0)):0;}
function tick(){
  const a=active;if(!a)return;
  const elapsed=durationOf(a);
  $('timerDisplay').textContent=formatTime(elapsed);
  $('dimTime').textContent=formatTime(elapsed);
  if(a.mode==='video'&&elapsed>=GYM_LIMIT_MS&&!busy){toast('10 Minuten erreicht, Video wird gespeichert.');stopSession();return;}
  if(Date.now()-checkpointAt>12000&&!busy){
    checkpointAt=Date.now();
    dbGet('sessions',a.id).then(s=>{if(active===a&&s?.status==='draft'){s.durationMs=elapsed;return dbPut('sessions',s);}}).catch(()=>{});
  }
}
function setDim(state){
  dimmed=!!state;
  $('dimScreen').classList.toggle('show',dimmed);
  $('dimScreen').setAttribute('aria-hidden',String(!dimmed));
  if(dimmed)tick();
}
function paintVideo(video,canvas,mirror){
  const ctx=canvas.getContext('2d',{alpha:false});
  ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);
  const w=video.videoWidth||1280,h=video.videoHeight||720;
  const ratio=Math.max(canvas.width/w,canvas.height/h);
  const tw=w*ratio,th=h*ratio,x=(canvas.width-tw)/2,y=(canvas.height-th)/2;
  if(mirror){ctx.save();ctx.translate(canvas.width,0);ctx.scale(-1,1);ctx.drawImage(video,x,y,tw,th);ctx.restore();}
  else ctx.drawImage(video,x,y,tw,th);
}
function canvasBlob(canvas,type='image/jpeg',quality=.55){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Bild konnte nicht gespeichert werden.')),type,quality));}
async function sampleFrame(){
  const a=active;
  if(!a||a.mode!=='timelapse'||a.writing||a.pausedAt||busy||switching||document.hidden||Date.now()<a.nextSampleAt||preview.readyState<2||!preview.videoWidth)return;
  a.writing=true;a.nextSampleAt=Date.now()+a.sampleEveryMs;
  try{
    const factor=Math.min(1,800/Math.max(preview.videoWidth,preview.videoHeight));
    captureCanvas.width=Math.max(2,Math.round(preview.videoWidth*factor));
    captureCanvas.height=Math.max(2,Math.round(preview.videoHeight*factor));
    paintVideo(preview,captureCanvas,facing==='user');
    const stamp=durationOf(a);
    const blob=await canvasBlob(captureCanvas,'image/jpeg',.48);
    await dbPut('frames',{sid:a.id,n:a.seq++,blob,elapsedMs:stamp});
    a.framesStored++;
    a.thumbnail=blob;
    if(a.framesStored>MAX_FRAMES){a.framesStored=await deleteItems('frames',a.id,true);a.sampleEveryMs*=2;}
  }catch(e){toast('Einzelbild nicht gespeichert: '+e.message,6500);}
  finally{a.writing=false;}
}
async function startSession(){
  if(active||busy||switching)return;
  busy=true;updateUI();
  let draftId;
  try{
    await openDB();
    if(!previewStream||previewStream.getVideoTracks().every(t=>t.readyState!=='live'))await openCamera(facing);
    if(mode==='timelapse'&&!captureCanvas.toBlob)throw new Error('Zeitraffer in diesem Browser nicht unterstützt.');
    if(mode==='video'&&chooseMime()===null)throw new Error('Videoaufnahme in diesem Browser nicht unterstützt.');
    const title=$('sessionTitle').value.trim()||(mode==='video'?'Gym-Session':'Fokus-Session');
    const session={id:makeId(),mode,title,category:mode==='video'?'Training':'Fokus',startedAt:Date.now(),pausedMs:0,pausedAt:null,stream:previewStream,framesStored:0,seq:0,sampleEveryMs:3000,nextSampleAt:0,writing:false,thumbnail:null,recorder:null,mime:'',chunkNumber:0,writes:[],writeError:null,durationMs:0};
    draftId=session.id;
    await dbPut('sessions',{id:session.id,title,category:session.category,mode,startedAt:session.startedAt,durationMs:0,status:'draft'});
    if(mode==='video'){
      const mime=chooseMime();
      try{session.recorder=new MediaRecorder(previewStream,mime?{mimeType:mime,videoBitsPerSecond:1300000}:{videoBitsPerSecond:1300000});}
      catch{session.recorder=new MediaRecorder(previewStream);}
      session.mime=session.recorder.mimeType||mime||'video/mp4';
      session.recorder.ondataavailable=event=>{
        if(!event.data?.size)return;
        const n=session.chunkNumber++;
        session.writes.push(dbPut('chunks',{sid:session.id,n,blob:event.data}).catch(e=>{session.writeError=e;}));
      };
      session.recorder.onerror=e=>{session.writeError=e.error||new Error('Videoaufnahme fehlgeschlagen.');};
      session.recorder.start(5000);
    }
    active=session;
    busy=false;
    await acquireWakeLock();
    tickTimer=setInterval(tick,1000);
    if(mode==='timelapse'){sampleTimer=setInterval(sampleFrame,850);void sampleFrame();}
    if(settings.autoDim)dimTimer=setTimeout(()=>{if(active===session&&!busy)setDim(true);},15000);
    tick();updateUI();
    toast('Aufnahme läuft. Bitte die App geöffnet lassen.');
  }catch(e){
    if(draftId){try{await deleteSession(draftId);}catch{}}
    active=null;busy=false;updateUI();toast(cameraError(e),6500);
  }
}
function paintCover(ctx,img,width,height){
  ctx.fillStyle='#080808';ctx.fillRect(0,0,width,height);
  const w=img.width,h=img.height;const ratio=Math.max(width/w,height/h);
  ctx.drawImage(img,(width-w*ratio)/2,(height-h*ratio)/2,w*ratio,h*ratio);
}
function paintElapsed(ctx,elapsed,width){
  const size=Math.max(16,Math.min(38,Math.round(width*.044)));
  const pad=Math.max(10,size*.55);
  const time=formatTime(elapsed);
  ctx.save();ctx.font=`700 ${size}px system-ui,-apple-system,sans-serif`;
  const txtWidth=ctx.measureText(time).width;
  const x=pad,y=pad,w=txtWidth+pad*2.5,h=size+pad*1.2,r=Math.min(13,h/3);
  ctx.fillStyle='rgba(0,0,0,.8)';ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.fill();
  ctx.fillStyle='#edc96a';ctx.textBaseline='middle';ctx.fillText(time,x+pad*1.25,y+h/2+1);ctx.restore();
}
async function readImage(blob){
  if('createImageBitmap' in window){try{const image=await createImageBitmap(blob);return {image,close:()=>image.close()};}catch{}}
  const url=URL.createObjectURL(blob);
  try{
    const image=new Image();image.src=url;
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;});
    return {image,close:()=>URL.revokeObjectURL(url)};
  }catch(e){URL.revokeObjectURL(url);throw e;}
}
async function buildSheet(frames){
  const selected=frames.filter((_,i)=>i%Math.max(1,Math.ceil(frames.length/24))===0).slice(0,24);
  const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=800;
  const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#0a0a0a';ctx.fillRect(0,0,1200,800);
  for(let i=0;i<selected.length;i++){
    const {image,close}=await readImage(selected[i].blob);const x=i%6*200,y=Math.floor(i/6)*200;
    ctx.save();ctx.beginPath();ctx.rect(x,y,200,200);ctx.clip();ctx.translate(x,y);paintCover(ctx,image,200,200);ctx.restore();close();
  }
  return {blob:await canvasBlob(canvas,'image/jpeg',.83),mediaType:'image',mime:'image/jpeg'};
}
async function buildTimelapse(frames,durationMs){
  if(!frames.length)throw new Error('Keine Einzelbilder aufgenommen.');
  if(!window.MediaRecorder||!HTMLCanvasElement.prototype.captureStream||chooseMime()===null)return buildSheet(frames);
  const first=await readImage(frames[0].blob);
  const canvas=document.createElement('canvas');canvas.width=first.image.width;canvas.height=first.image.height;
  const ctx=canvas.getContext('2d',{alpha:false});paintCover(ctx,first.image,canvas.width,canvas.height);paintElapsed(ctx,0,canvas.width);first.close();
  const stream=canvas.captureStream(12);
  let recorder,mime=chooseMime();
  try{recorder=new MediaRecorder(stream,mime?{mimeType:mime,videoBitsPerSecond:750000}:{videoBitsPerSecond:750000});}
  catch{closeTracks(stream);return buildSheet(frames);}
  mime=recorder.mimeType||mime||'video/mp4';
  const chunks=[];
  recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};
  const finished=new Promise((resolve,reject)=>{
    recorder.addEventListener('stop',resolve,{once:true});
    recorder.addEventListener('error',e=>reject(e.error||new Error('Video-Encoder meldet einen Fehler.')),{once:true});
  });
  const realDuration=Math.max(0,durationMs||0);
  const stamps=frames.map((f,i)=>Number.isFinite(f.elapsedMs)?Math.min(realDuration,Math.max(0,f.elapsedMs)):realDuration*i/Math.max(1,frames.length-1));
  let index=0,loadedIndex=-1,loaded=null;
  async function drawAt(elapsed){
    while(index+1<frames.length&&stamps[index+1]<=elapsed)index++;
    if(index!==loadedIndex){const next=await readImage(frames[index].blob);loaded?.close();loaded=next;loadedIndex=index;}
    paintCover(ctx,loaded.image,canvas.width,canvas.height);paintElapsed(ctx,elapsed,canvas.width);
  }
  try{
    recorder.start();
    const length=CLIP_SECONDS*1000,frameInterval=100,started=performance.now();
    let targetTick=1;
    while(performance.now()-started<length){
      const played=Math.max(0,Math.min(length,performance.now()-started));
      await drawAt(realDuration*Math.min(1,played/(length-frameInterval)));
      const wait=started+targetTick++*frameInterval-performance.now();
      await delay(Math.max(0,wait));
    }
    await drawAt(realDuration);
    if(recorder.state!=='inactive')recorder.stop();
    await Promise.race([finished,delay(9000).then(()=>{throw new Error('Video-Encoder antwortet nicht.');})]);
    const blob=new Blob(chunks,{type:mime});
    if(!blob.size)throw new Error('Kein Video erzeugt.');
    return {blob,mediaType:'video',mime};
  }catch(e){
    if(recorder.state!=='inactive')try{recorder.stop();}catch{}
    return buildSheet(frames);
  }finally{loaded?.close();closeTracks(stream);}
}
async function completeDraft(id,runtime=null){
  const saved=await dbGet('sessions',id);
  if(!saved||saved.status!=='draft')throw new Error('Session nicht gefunden.');
  const durationMs=runtime?.durationMs??saved.durationMs;
  let result={blob:null,mediaType:'timer',mime:''};let thumbnail=runtime?.thumbnail||null;
  if(saved.mode==='timelapse'){
    const frames=await dbAll('frames',id);
    if(!frames.length)throw new Error('Keine Zeitraffer-Bilder vorhanden.');
    thumbnail=thumbnail||frames[Math.floor(frames.length/2)].blob;
    toast('Zeitraffer wird erstellt (ca. 30 Sekunden) – App bitte offen lassen.',35000);
    result=await buildTimelapse(frames,durationMs);
  }else if(saved.mode==='video'){
    const chunks=await dbAll('chunks',id);
    const mime=runtime?.mime||chunks[0]?.blob?.type||'video/mp4';
    const blob=new Blob(chunks.map(x=>x.blob),{type:mime});
    if(!blob.size)throw new Error('Videodaten fehlen.');
    result={blob,mediaType:'video',mime};
  }else throw new Error('Unbekannter Aufnahmemodus.');
  await dbPut('sessions',{...saved,durationMs,status:'complete',mediaType:result.mediaType,mime:result.mime,blob:result.blob,thumbnail,completedAt:Date.now()});
  await Promise.all([deleteItems('frames',id),deleteItems('chunks',id)]);
  if(result.mediaType==='image')toast('Browser-Encoding nicht verfügbar. Bildübersicht als Ersatz gespeichert.',7000);
}
async function stopSession(){
  if(!active||busy)return;
  busy=true;
  const session=active;
  session.durationMs=durationOf(session);
  clearInterval(tickTimer);clearInterval(sampleTimer);clearTimeout(dimTimer);
  tickTimer=sampleTimer=dimTimer=null;
  setDim(false);updateUI();
  try{
    let retries=0;
    while(session.writing&&retries++<75)await delay(100);
    if(session.recorder&&session.recorder.state!=='inactive'){
      await new Promise(resolve=>{
        session.recorder.addEventListener('stop',resolve,{once:true});
        try{session.recorder.stop();}catch{resolve();}
        setTimeout(resolve,4000);
      });
    }
    await Promise.all(session.writes);
    if(session.writeError)throw session.writeError;
    // Release the camera during the 30-second video export to save battery.
    closeTracks(previewStream);previewStream=null;preview.pause();preview.srcObject=null;setPreviewState(false);
    await completeDraft(session.id,session);
    toast('Aufnahme gespeichert – unter Aufnahmen ansehen.',5600);
  }catch(e){toast('Speichern fehlgeschlagen. Rohdaten bleiben zur Wiederherstellung erhalten: '+e.message,9000);}
  finally{
    await releaseWakeLock();
    if(previewStream){closeTracks(previewStream);previewStream=null;preview.srcObject=null;setPreviewState(false);}
    active=null;busy=false;updateUI();$('timerDisplay').textContent='00:00:00';
    await renderLibrary();
  }
}
function dateLabel(time){return new Date(time).toLocaleDateString('de-DE',{day:'2-digit',month:'short',year:'numeric'});}
async function renderLibrary(){
  const list=$('libraryList');thumbUrls.forEach(u=>URL.revokeObjectURL(u));thumbUrls=[];
  let records=[];try{records=(await dbAll('sessions')).sort((a,b)=>b.startedAt-a.startedAt);}catch{list.innerHTML='<div class="empty-state">Aufnahmen konnten nicht gelesen werden.</div>';return;}
  list.replaceChildren();
  if(!records.length){list.innerHTML='<div class="empty-state">Noch keine Aufnahmen. Starte deine erste Session.</div>';return;}
  for(const s of records){
    const card=document.createElement('article');card.className='session-card';
    const thumb=s.thumbnail?URL.createObjectURL(s.thumbnail):'icon-192.png';
    if(s.thumbnail)thumbUrls.push(thumb);
    const media=s.status==='draft'?'UNTERBROCHEN':s.mediaType==='image'?'BILDÜBERSICHT':s.mode==='timelapse'?'ZEITRAFFER':s.mode==='video'?'GYM-VIDEO':'SESSION';
    card.innerHTML=`<div class="session-body"><img class="session-thumb" src="${thumb}" alt="Vorschaubild"><div class="session-meta"><span class="session-type">${media}</span><h3>${escapeHtml(s.title||'Session')}</h3><p>${dateLabel(s.startedAt)} · ${formatTime(s.durationMs||0)}</p><p>${s.mode==='timelapse'?'30s-Zeitraffer':s.mode==='video'?'Normale Aufnahme':'Fokuszeit'}</p></div></div><div class="session-actions"></div>`;
    const actions=card.querySelector('.session-actions');
    const button=(label,handler,cls='')=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.className=cls;b.addEventListener('click',handler);actions.append(b);};
    if(s.status==='draft')button('Retten',()=>recoverDraft(s.id));
    else if(s.blob)button('Ansehen',()=>openMedia(s));
    else button('Erfasst',()=>toast('Diese ältere Session hat kein Video.'));
    if(s.status==='complete'&&s.blob)button('Export',()=>shareSession(s));
    button('Löschen',()=>removeSession(s.id),'delete-btn');
    list.append(card);
  }
}
async function recoverDraft(id){
  if(active||busy)return;
  if(!confirm('Unterbrochene Aufnahme aus lokal gespeicherten Daten retten?'))return;
  busy=true;updateUI();
  try{await completeDraft(id);toast('Aufnahme wiederhergestellt.');}
  catch(e){toast('Wiederherstellung nicht möglich: '+e.message,7000);}
  finally{busy=false;updateUI();await renderLibrary();}
}
async function removeSession(id){
  if(!confirm('Diese Aufnahme endgültig löschen?'))return;
  try{await deleteSession(id);toast('Aufnahme gelöscht.');await renderLibrary();}
  catch(e){toast('Löschen fehlgeschlagen: '+e.message);}
}
function openMedia(session){
  if(!session.blob)return;
  if(dialogUrl)URL.revokeObjectURL(dialogUrl);
  currentDialogSession=session;
  dialogUrl=URL.createObjectURL(session.blob);
  $('dialogTitle').textContent=session.title||'Session';
  $('dialogInfo').textContent=`${dateLabel(session.startedAt)} · ${formatTime(session.durationMs||0)} · ${session.mediaType==='image'?'Bildübersicht':session.mode==='timelapse'?'Zeitraffer mit Timer':'Normalvideo'}`;
  const video=session.mediaType==='video';
  $('savedVideo').hidden=!video;$('savedImage').hidden=video;
  if(video){$('savedVideo').src=dialogUrl;$('savedImage').removeAttribute('src');}
  else{$('savedImage').src=dialogUrl;$('savedVideo').removeAttribute('src');}
  $('videoDialog').showModal();
}
function closeDialog(){
  $('savedVideo').pause();$('savedVideo').removeAttribute('src');$('savedVideo').load();$('savedImage').removeAttribute('src');
  if(dialogUrl)URL.revokeObjectURL(dialogUrl);
  dialogUrl=null;currentDialogSession=null;$('videoDialog').close();
}
async function shareSession(session){
  if(!session.blob)return;
  const mime=session.mime||session.blob.type;
  const ext=session.mediaType==='image'?'jpg':mime.includes('webm')?'webm':'mp4';
  const name=(session.title||'Session').replace(/[^\wäöüÄÖÜß-]+/g,'-').slice(0,38);
  const filename=`FocusFrame-${name}-${dateKey(new Date(session.startedAt))}.${ext}`;
  const file=new File([session.blob],filename,{type:mime||(ext==='jpg'?'image/jpeg':'video/mp4')});
  if(navigator.canShare?.({files:[file]})){
    try{await navigator.share({files:[file],title:session.title});return;}catch(e){if(e.name==='AbortError')return;}
  }
  const url=URL.createObjectURL(session.blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  toast('Datei wird zum Herunterladen bereitgestellt.');
}
async function showTab(name){
  if(active||busy||switching){toast('Bitte zuerst die Aufnahme beenden.');return;}
  if(name==='library'&&previewStream){closeTracks(previewStream);previewStream=null;preview.srcObject=null;setPreviewState(false);}
  $('view-camera').classList.toggle('active',name==='camera');
  $('view-library').classList.toggle('active',name==='library');
  document.querySelectorAll('.nav-btn').forEach(btn=>{const selected=btn.dataset.tab===name;btn.classList.toggle('active',selected);if(selected)btn.setAttribute('aria-current','page');else btn.removeAttribute('aria-current');});
  if(name==='library')await renderLibrary();
  window.scrollTo({top:0,behavior:'instant'});
}
function onVisibilityChange(){
  const a=active;if(!a)return;
  if(document.hidden){if(!a.pausedAt)a.pausedAt=Date.now();releaseWakeLock();}
  else{
    if(a.pausedAt){a.pausedMs+=Date.now()-a.pausedAt;a.pausedAt=null;}
    if(!previewStream||previewStream.getVideoTracks().every(t=>t.readyState!=='live')){
      toast('iOS hat die Kamera unterbrochen. Session wird gespeichert.');stopSession();return;
    }
    acquireWakeLock();tick();
  }
}
function bindUI(){
  document.querySelectorAll('.mode-btn').forEach(button=>button.addEventListener('click',()=>setMode(button.dataset.mode)));
  $('activateCamera').addEventListener('click',activateCamera);
  $('flipCamera').addEventListener('click',flipCamera);
  $('startStop').addEventListener('click',()=>active?stopSession():startSession());
  $('dimButton').addEventListener('click',()=>{if(active)setDim(true);});
  $('dimRestore').addEventListener('click',()=>setDim(false));
  $('dimStop').addEventListener('click',stopSession);
  $('autoDimSetting').checked=settings.autoDim;
  $('autoDimSetting').addEventListener('change',e=>{settings.autoDim=e.target.checked;try{localStorage.setItem(SETTINGS_KEY,JSON.stringify({...JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}'),autoDim:settings.autoDim}));}catch{}if(active){clearTimeout(dimTimer);if(settings.autoDim&&!dimmed)dimTimer=setTimeout(()=>{if(active&&!busy)setDim(true);},15000);}});
  document.querySelectorAll('.nav-btn').forEach(button=>button.addEventListener('click',()=>showTab(button.dataset.tab)));
  $('closeDialog').addEventListener('click',closeDialog);
  $('videoDialog').addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
  $('videoDialog').addEventListener('click',e=>{if(e.target===$('videoDialog'))closeDialog();});
  $('shareVideo').addEventListener('click',()=>{if(currentDialogSession)shareSession(currentDialogSession);});
  document.addEventListener('visibilitychange',onVisibilityChange);
  window.addEventListener('pagehide',()=>releaseWakeLock());
  setMode('timelapse');setPreviewState(false);updateUI();
}
async function initialize(){
  bindUI();
  try{await openDB();await renderLibrary();}catch(e){toast('Lokaler Speicher nicht verfügbar: '+e.message,6500);}
  if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
initialize();
