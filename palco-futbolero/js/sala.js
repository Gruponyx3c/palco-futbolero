/* =========================================================
   Palco Futbolero · lógica de la sala
   Conexión directa entre navegadores (WebRTC) usando PeerJS.

   Seguridad:
   - Sala de espera: nadie entra sin que el anfitrión lo acepte.
   - El anfitrión puede cerrar la sala, silenciar y sacar gente.
   - Solo el anfitrión puede enviar la pantalla.
   - Solo se aceptan voces de personas aceptadas por el anfitrión.
   - Límite de mensajes para evitar spam y límite de personas.
   - Todo el texto se muestra como texto (nunca como código).
   ========================================================= */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const store={
  get(k,d){try{return localStorage.getItem(k)??d}catch(e){return d}},
  set(k,v){try{localStorage.setItem(k,v)}catch(e){}}
};
const MAX_GUESTS=8;            // invitados como máximo (más pesa en el internet del anfitrión)
const MSG_LIMIT=6, MSG_WINDOW=10000; // 6 mensajes o reacciones cada 10 segundos por persona

let peer=null,isHost=false,inRoom=false,myName='',myMic=null,hasMic=false,micOn=true,display=null;
let hostConn=null,hostId='',roomCode='',locked=false,waiting=false;
const guests={};        // anfitrión: id -> {conn,name,times:[]}
const pending={};       // anfitrión: id -> {conn,name}
const audios={};        // id -> <audio>
const screenCalls={};   // anfitrión: id -> llamada de pantalla
const micCalls={};      // id -> llamada de voz
const held=[];          // invitado: llamadas de voz esperando confirmación
let allowed=new Set();  // invitado: ids aceptados por el anfitrión
let mutedIds=new Set(); // silenciados por el anfitrión
const st={h:0,a:0,sec:0,half:1,run:false,home:'Barcelona',away:'Real Madrid'};

/* ---------- respaldo de PeerJS ---------- */
// Si js/peerjs.min.js no está en la carpeta, se usa la copia de unpkg.
if(!window.Peer){
  const s=document.createElement('script');
  s.src='https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
  s.crossOrigin='anonymous';
  document.head.appendChild(s);
}

/* ---------- utilidades ---------- */
const clean=s=>String(s||'').replace(/[<>\u0000-\u001f]/g,'').replace(/\s+/g,' ').trim().slice(0,24)||'Invitado';
const cleanText=s=>String(s||'').replace(/[\u0000-\u0008\u000b-\u001f]/g,'').trim().slice(0,300);
const REACTS=['¡GOL!','¡UFF!','¡PENAL!','¡ÁRBITRO!'];
const abbr=s=>{s=(s||'').trim();const w=s.split(/\s+/).filter(Boolean);return (w.length>1?w.map(x=>x[0]).join('').slice(0,3):s.slice(0,3)).toUpperCase()||'---'};
const fmt=s=>String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
const CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randCode(){let s='';const a=new Uint32Array(5);crypto.getRandomValues(a);for(const n of a)s+=CODE_CHARS[n%CODE_CHARS.length];return s}
function lobbyMsg(t){$('lobbyMsg').textContent=t||'';$('lobbyMsg').hidden=!t}
function inviteLink(){return location.origin+location.pathname+'#'+roomCode}
function isObj(d){return d&&typeof d==='object'&&typeof d.t==='string'}

$('name').value=store.get('pf-name','');
const fromHash=(location.hash||'').replace('#','').toUpperCase();
if(/^[A-Z0-9]{5}$/.test(fromHash)){$('codeIn').value=fromHash;setTimeout(()=>$('name').focus(),50)}

async function getMic(){
  try{
    const s=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    hasMic=true;return s;
  }catch(e){
    hasMic=false;micOn=false;
    const ac=new (window.AudioContext||window.webkitAudioContext)();
    return ac.createMediaStreamDestination().stream; // silencio: igual se puede conectar
  }
}
function addAudio(id,stream){
  let a=audios[id];
  if(!a){a=document.createElement('audio');a.autoplay=true;audios[id]=a;document.body.appendChild(a)}
  a.srcObject=stream;a.muted=mutedIds.has(id);a.play().catch(()=>{});
}
function dropPeerAudio(id){
  if(audios[id]){audios[id].remove();delete audios[id]}
  if(micCalls[id]){try{micCalls[id].close()}catch(e){}delete micCalls[id]}
}
function applyMutes(){for(const id in audios)audios[id].muted=mutedIds.has(id)}

/* ---------- llamadas ---------- */
function acceptMic(call){
  micCalls[call.peer]=call;
  call.answer(myMic);
  call.on('stream',s=>addAudio(call.peer,s));
  call.on('close',()=>dropPeerAudio(call.peer));
}
function onCall(call){
  const kind=call.metadata&&call.metadata.kind;
  if(isHost){
    // El anfitrión solo acepta voces de invitados ya aceptados.
    if(kind==='mic'&&guests[call.peer])return acceptMic(call);
    return call.close();
  }
  if(kind==='screen'){
    if(call.peer!==hostId)return call.close(); // solo el anfitrión comparte pantalla
    call.answer();
    call.on('stream',s=>showScreen(s,false));
    call.on('close',hideScreen);
    return;
  }
  if(kind==='mic'){
    if(allowed.has(call.peer))return acceptMic(call);
    // Puede llegar un instante antes que la lista del anfitrión: esperamos hasta 4 s.
    held.push(call);
    setTimeout(()=>{const i=held.indexOf(call);if(i>=0){held.splice(i,1);call.close()}},4000);
    return;
  }
  call.close();
}
function releaseHeld(){
  for(let i=held.length-1;i>=0;i--)if(allowed.has(held[i].peer)){acceptMic(held[i]);held.splice(i,1)}
}
function callMic(id){
  if(micCalls[id])return;
  const c=peer.call(id,myMic,{metadata:{kind:'mic'}});
  if(!c)return;
  micCalls[id]=c;
  c.on('stream',s=>addAudio(id,s));
  c.on('close',()=>dropPeerAudio(id));
}
function startPeer(id){
  peer=id?new Peer(id):new Peer();
  peer.on('call',onCall);
  peer.on('disconnected',()=>{try{peer.reconnect()}catch(e){}});
}

/* ---------- crear / entrar ---------- */
async function createRoom(){
  myName=clean($('name').value);store.set('pf-name',myName);
  lobbyMsg('Creando la sala…');
  if(!myMic)myMic=await getMic();
  const code=randCode();
  startPeer('palco-'+code);
  peer.on('open',()=>{isHost=true;roomCode=code;hostId=peer.id;enterRoom()});
  peer.on('connection',onGuestConn);
  peer.on('error',e=>{
    if(e.type==='unavailable-id'){peer.destroy();createRoom()}
    else if(!inRoom)lobbyMsg('No se pudo crear la sala. Revisa tu conexión a internet e inténtalo de nuevo.');
  });
}
async function joinRoom(code){
  code=String(code||'').trim().toUpperCase();
  if(!/^[A-Z0-9]{5}$/.test(code))return lobbyMsg('El código tiene 5 letras o números. Revísalo y vuelve a intentar.');
  if(waiting)return;
  myName=clean($('name').value);store.set('pf-name',myName);
  lobbyMsg('Conectando con la sala '+code+'…');
  if(!myMic)myMic=await getMic();
  hostId='palco-'+code;
  startPeer();
  peer.on('open',()=>{
    hostConn=peer.connect(hostId,{reliable:true});
    hostConn.on('open',()=>{waiting=true;roomCode=code;hostConn.send({t:'hello',name:myName})});
    hostConn.on('data',guestData);
    hostConn.on('close',()=>{
      if(inRoom){sys('El anfitrión cerró la sala.');hideScreen();$('people').innerHTML=''}
      else if(waiting){waiting=false;lobbyMsg('Se perdió la conexión con la sala. Inténtalo de nuevo.')}
    });
  });
  peer.on('error',e=>{
    if(inRoom)return;
    waiting=false;
    lobbyMsg(e.type==='peer-unavailable'
      ?'No encontramos la sala '+code+'. Revisa el código o pide al anfitrión que la cree de nuevo.'
      :'No se pudo conectar. Revisa tu conexión e inténtalo otra vez.');
    try{peer.destroy()}catch(x){}
  });
}
function leaveToLobby(text){
  try{peer&&peer.destroy()}catch(e){}
  inRoom=false;waiting=false;hideScreen();
  for(const id in audios)dropPeerAudio(id);
  $('room').hidden=true;$('lobby').hidden=false;
  lobbyMsg(text);
}
function enterRoom(){
  inRoom=true;waiting=false;lobbyMsg('');
  $('lobby').hidden=true;$('room').hidden=false;
  $('codeOut').textContent=roomCode;
  $('hostPanel').hidden=!isHost;
  $('lockBtn').hidden=!isHost;
  $('inviteBtn').hidden=!isHost;
  const canShare=!!(navigator.mediaDevices&&navigator.mediaDevices.getDisplayMedia);
  $('shareBtn').hidden=!isHost||!canShare;
  try{history.replaceState(null,'','#'+roomCode)}catch(e){}
  if(isHost){
    $('waitTitle').textContent='Pon el partido';
    $('waitText').textContent=canShare
      ?'Abre el partido en otra pestaña. Luego presiona Compartir partido, elige esa pestaña y activa "Compartir también el audio de la pestaña".'
      :'Este navegador no permite compartir pantalla. Abre la sala en Chrome o Edge desde una computadora.';
    roster();renderPending();
    sys('Sala creada. Manda la invitación: cada persona que llegue te pedirá permiso para entrar.');
  }
  renderRole();renderMic();renderScore();
  try{navigator.wakeLock&&navigator.wakeLock.request('screen').catch(()=>{})}catch(e){}
}
function renderRole(){
  $('roleTag').textContent=isHost?(locked?'Eres el anfitrión · sala cerrada':'Eres el anfitrión'):'Estás viendo como invitado';
}

/* ---------- anfitrión: sala de espera ---------- */
function onGuestConn(conn){
  conn.on('data',d=>hostData(conn,d));
  conn.on('close',()=>{
    const id=conn.peer;
    if(pending[id]){delete pending[id];renderPending();return}
    const g=guests[id];if(!g)return;
    delete guests[id];
    if(screenCalls[id]){try{screenCalls[id].close()}catch(e){}delete screenCalls[id]}
    dropPeerAudio(id);
    relay({t:'gone',id});
    sys(g.name+' salió.');roster();
  });
  // Si en 15 s no se presenta, se corta.
  setTimeout(()=>{if(!guests[conn.peer]&&!pending[conn.peer])try{conn.close()}catch(e){}},15000);
}
function deny(conn,reason){
  try{conn.send({t:'denied',reason})}catch(e){}
  setTimeout(()=>{try{conn.close()}catch(e){}},400);
}
function hostData(conn,d){
  if(!isObj(d))return;
  const id=conn.peer;
  if(d.t==='hello'){
    if(guests[id]||pending[id])return;
    if(locked)return deny(conn,'locked');
    if(Object.keys(guests).length+Object.keys(pending).length>=MAX_GUESTS)return deny(conn,'full');
    pending[id]={conn,name:clean(d.name)};
    conn.send({t:'waiting',host:myName});
    renderPending();
    onMsg({t:'sys',text:pending[id].name+' quiere entrar. Acéptalo o recházalo en "Quieren entrar".'});
    return;
  }
  const g=guests[id];
  if(!g)return; // quien no fue aceptado no puede hacer nada
  if(d.t==='chat'||d.t==='react'){
    const now=Date.now();
    g.times=g.times.filter(t=>now-t<MSG_WINDOW);
    if(g.times.length>=MSG_LIMIT){
      if(!g.warned){g.warned=true;conn.send({t:'sys',text:'Vas muy rápido. Espera unos segundos para volver a escribir.'});setTimeout(()=>g.warned=false,MSG_WINDOW)}
      return;
    }
    g.times.push(now);
    let m;
    if(d.t==='chat'){const text=cleanText(d.text);if(!text)return;m={t:'chat',name:g.name,text}}
    else{if(!REACTS.includes(d.k))return;m={t:'react',name:g.name,k:d.k}}
    relay(m,id);onMsg(m);
  }
}
function approve(id){
  const p=pending[id];if(!p)return;
  delete pending[id];
  if(locked)return deny(p.conn,'locked'),renderPending();
  guests[id]={conn:p.conn,name:p.name,times:[]};
  roster(); // primero la lista, así los demás ya lo reconocen cuando los llame
  p.conn.send({t:'approved'});
  p.conn.send({t:'roster',list:rosterList()});
  p.conn.send({t:'peers',ids:[peer.id,...Object.keys(guests).filter(x=>x!==id)]});
  p.conn.send({t:'score',st});
  sys(p.name+' entró a la sala.');
  if(display)callScreen(id);
  renderPending();
}
function reject(id){
  const p=pending[id];if(!p)return;
  delete pending[id];deny(p.conn,'rejected');renderPending();
}
function kick(id){
  const g=guests[id];if(!g)return;
  try{g.conn.send({t:'kicked'})}catch(e){}
  setTimeout(()=>{try{g.conn.close()}catch(e){}},300);
  delete guests[id];
  if(screenCalls[id]){try{screenCalls[id].close()}catch(e){}delete screenCalls[id]}
  dropPeerAudio(id);mutedIds.delete(id);
  relay({t:'gone',id});
  sys(g.name+' fue sacado de la sala.');roster();
}
function toggleMute(id){
  if(!guests[id])return;
  mutedIds.has(id)?mutedIds.delete(id):mutedIds.add(id);
  applyMutes();
  const on=mutedIds.has(id);
  try{guests[id].conn.send({t:'sys',text:on?'El anfitrión te silenció. Los demás no te escuchan por ahora.':'El anfitrión te volvió a dar la palabra.'})}catch(e){}
  roster();
}
function relay(m,except){for(const id in guests){const c=guests[id].conn;if(id!==except&&c.open)c.send(m)}}
function rosterList(){
  return [{id:peer.id,name:myName,host:true},...Object.entries(guests).map(([id,g])=>({id,name:g.name,muted:mutedIds.has(id)}))];
}
function roster(){const list=rosterList();renderRoster(list);relay({t:'roster',list})}
function sys(text){onMsg({t:'sys',text});if(isHost)relay({t:'sys',text})}
function toggleLock(){
  locked=!locked;
  if(locked)for(const id in pending)reject(id);
  $('lockBtn').textContent=locked?'Abrir la sala':'Cerrar la sala';
  $('lockBtn').classList.toggle('danger',locked);
  renderRole();
  sys(locked?'La sala está cerrada: nadie más puede pedir entrar.':'La sala está abierta otra vez.');
}

/* ---------- anfitrión: pantalla ---------- */
async function share(){
  if(display)return stopShare();
  try{
    display=await navigator.mediaDevices.getDisplayMedia({
      video:{frameRate:30},
      audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},
      selfBrowserSurface:'exclude',systemAudio:'include'
    });
  }catch(e){display=null;return}
  showScreen(display,true);
  display.getVideoTracks()[0].onended=stopShare;
  if(!display.getAudioTracks().length)
    onMsg({t:'sys',text:'Estás compartiendo sin sonido. Detén y vuelve a compartir activando "Compartir también el audio de la pestaña".'});
  Object.keys(guests).forEach(callScreen);
  sys(myName+' empezó a compartir el partido.');
  $('shareBtn').textContent='Dejar de compartir';$('shareBtn').classList.replace('primary','danger');
}
function callScreen(id){const c=peer.call(id,display,{metadata:{kind:'screen'}});if(c)screenCalls[id]=c}
function stopShare(){
  if(!display)return;
  display.getTracks().forEach(t=>t.stop());display=null;
  Object.values(screenCalls).forEach(c=>{try{c.close()}catch(e){}});
  for(const k in screenCalls)delete screenCalls[k];
  relay({t:'stopped'});hideScreen();
  $('shareBtn').textContent='Compartir partido';$('shareBtn').classList.replace('danger','primary');
}

/* ---------- invitado ---------- */
function guestData(d){
  if(!isObj(d))return;
  if(!inRoom){
    if(d.t==='waiting')lobbyMsg('Listo. Esperando que '+clean(d.host)+' te deje entrar…');
    else if(d.t==='approved')enterRoom();
    else if(d.t==='denied'){
      waiting=false;
      lobbyMsg(d.reason==='locked'?'El anfitrión cerró la sala y ya no está dejando entrar a nadie.'
        :d.reason==='full'?'La sala está llena. Pídele al anfitrión que te avise cuando haya espacio.'
        :'El anfitrión no aceptó tu entrada.');
      try{peer.destroy()}catch(e){}
    }
    return;
  }
  switch(d.t){
    case 'peers':(Array.isArray(d.ids)?d.ids:[]).forEach(id=>{if(id!==peer.id&&allowed.has(id))callMic(id)});break;
    case 'score':
      if(d.st&&typeof d.st==='object'){
        st.h=Math.max(0,+d.st.h|0);st.a=Math.max(0,+d.st.a|0);st.sec=Math.max(0,+d.st.sec|0);
        st.half=d.st.half===2?2:1;st.run=!!d.st.run;st.home=clean(d.st.home);st.away=clean(d.st.away);
        renderScore();if(d.goal)flash();
      }
      break;
    case 'roster':{
      const list=Array.isArray(d.list)?d.list:[];
      allowed=new Set(list.map(p=>p&&p.id).filter(Boolean));
      mutedIds=new Set(list.filter(p=>p&&p.muted).map(p=>p.id));
      for(const id in micCalls)if(!allowed.has(id))dropPeerAudio(id);
      applyMutes();releaseHeld();renderRoster(list);
      const me=list.find(p=>p&&p.id===peer.id);
      $('mutedNote').hidden=!(me&&me.muted);
      break;
    }
    case 'gone':allowed.delete(d.id);dropPeerAudio(d.id);break;
    case 'stopped':hideScreen();break;
    case 'kicked':leaveToLobby('El anfitrión te sacó de la sala.');break;
    case 'chat':onMsg({t:'chat',name:clean(d.name),text:cleanText(d.text)});break;
    case 'react':if(REACTS.includes(d.k))floatReact(d.k,clean(d.name));break;
    case 'sys':onMsg({t:'sys',text:cleanText(d.text)});break;
  }
}

/* ---------- pantalla ---------- */
const scr=$('screen');
function showScreen(stream,local){
  scr.srcObject=stream;scr.muted=!!local;scr.hidden=false;$('pitch').hidden=true;
  scr.play().then(()=>{$('unmuteBtn').hidden=true}).catch(()=>{
    scr.muted=true;scr.play().catch(()=>{});
    if(!local)$('unmuteBtn').hidden=false;
  });
}
function hideScreen(){scr.srcObject=null;scr.hidden=true;$('pitch').hidden=false;$('unmuteBtn').hidden=true}
$('unmuteBtn').onclick=()=>{scr.muted=false;scr.play().catch(()=>{});$('unmuteBtn').hidden=true};
$('vol').oninput=e=>{scr.volume=+e.target.value};

/* ---------- chat y reacciones ---------- */
function onMsg(m){
  if(m.t==='react')return floatReact(m.k,m.name);
  if(!m.text)return;
  const div=document.createElement('div');
  if(m.t==='sys'){div.className='sys';div.textContent=m.text}
  else{const b=document.createElement('b');b.textContent=m.name+': ';div.append(b,document.createTextNode(m.text))}
  const log=$('log');log.append(div);
  while(log.children.length>200)log.firstChild.remove();
  log.scrollTop=log.scrollHeight;
}
let myTimes=[];
function send(m){
  const now=Date.now();myTimes=myTimes.filter(t=>now-t<MSG_WINDOW);
  if(myTimes.length>=MSG_LIMIT)return onMsg({t:'sys',text:'Vas muy rápido. Espera unos segundos.'});
  myTimes.push(now);
  onMsg(m);if(isHost)relay(m);else if(hostConn&&hostConn.open)hostConn.send(m);
}
$('chatForm').onsubmit=e=>{
  e.preventDefault();const t=cleanText($('chatIn').value);if(!t)return;
  $('chatIn').value='';send({t:'chat',name:myName,text:t});
};
document.querySelectorAll('[data-r]').forEach(b=>b.onclick=()=>send({t:'react',name:myName,k:b.dataset.r}));
function floatReact(k,name){
  const layer=$('reacts');if(layer.children.length>12)return;
  const el=document.createElement('div');el.className='react';
  el.style.left=(6+Math.random()*68)+'%';
  el.textContent=k;const s=document.createElement('small');s.textContent=name;el.append(s);
  layer.append(el);setTimeout(()=>el.remove(),2900);
}

/* ---------- listas ---------- */
function renderRoster(list){
  const ul=$('people');ul.replaceChildren();
  list.forEach(p=>{
    if(!p)return;
    const li=document.createElement('li');
    const name=document.createElement('span');name.className='pname';name.textContent=clean(p.name);
    li.append(name);
    if(p.host)li.classList.add('host');
    if(p.muted){li.classList.add('muted');const m=document.createElement('span');m.className='tag';m.textContent='silenciado';li.append(m)}
    if(isHost&&!p.host){
      const acts=document.createElement('span');acts.className='acts';
      const mb=document.createElement('button');mb.textContent=p.muted?'Dar voz':'Silenciar';mb.onclick=()=>toggleMute(p.id);
      const kb=document.createElement('button');kb.textContent='Sacar';kb.className='danger';
      kb.onclick=()=>{
        if(kb.dataset.sure){kick(p.id)}else{kb.dataset.sure='1';kb.textContent='¿Seguro?';setTimeout(()=>{if(kb.isConnected){delete kb.dataset.sure;kb.textContent='Sacar'}},3000)}
      };
      acts.append(mb,kb);li.append(acts);
    }
    ul.append(li);
  });
}
function renderPending(){
  const ids=Object.keys(pending);
  $('pendingCard').hidden=!isHost||!ids.length;
  const ul=$('pending');ul.replaceChildren();
  ids.forEach(id=>{
    const li=document.createElement('li');
    const name=document.createElement('span');name.className='pname';name.textContent=pending[id].name;
    const acts=document.createElement('span');acts.className='acts';
    const ok=document.createElement('button');ok.className='primary';ok.textContent='Aceptar';ok.onclick=()=>approve(id);
    const no=document.createElement('button');no.textContent='Rechazar';no.onclick=()=>reject(id);
    acts.append(ok,no);li.append(name,acts);ul.append(li);
  });
  document.title=ids.length?'('+ids.length+') Palco Futbolero':'Palco Futbolero';
}

/* ---------- micrófono ---------- */
function renderMic(){
  const b=$('micBtn');
  b.textContent=!hasMic?'Sin micrófono':micOn?'Micrófono activo':'Micrófono apagado';
  b.classList.toggle('danger',hasMic&&!micOn);
  b.disabled=!hasMic;
}
$('micBtn').onclick=()=>{micOn=!micOn;myMic.getAudioTracks().forEach(t=>t.enabled=micOn);renderMic()};

/* ---------- marcador ---------- */
function renderScore(){
  $('hs').textContent=$('bHs').textContent=st.h;
  $('as').textContent=$('bAs').textContent=st.a;
  $('bHome').textContent=abbr(st.home);$('bAway').textContent=abbr(st.away);
  $('bClock').textContent=fmt(st.sec);$('bHalf').textContent=st.half+'T';
  $('clockBtn').textContent=st.run?'Pausar reloj':(st.sec?'Seguir reloj':'Iniciar reloj');
  $('halfBtn').textContent=st.half===1?'2.º tiempo':'1.er tiempo';
}
function flash(){const g=$('goal');g.classList.remove('show');void g.offsetWidth;g.classList.add('show')}
function pushScore(goal){renderScore();if(goal)flash();if(isHost)relay({t:'score',st,goal:!!goal})}
function goal(t,d){if(!isHost)return;st[t]=Math.max(0,st[t]+d);pushScore(d>0)}
document.querySelectorAll('[data-g]').forEach(b=>b.onclick=()=>goal(b.dataset.g,+b.dataset.d));
$('home').oninput=()=>{st.home=clean($('home').value);pushScore()};
$('away').oninput=()=>{st.away=clean($('away').value);pushScore()};
$('clockBtn').onclick=()=>{st.run=!st.run;pushScore()};
$('halfBtn').onclick=()=>{st.half=st.half===1?2:1;st.sec=st.half===2?45*60:0;pushScore()};
$('plus').onclick=()=>{st.sec+=60;pushScore()};
$('minus').onclick=()=>{st.sec=Math.max(0,st.sec-60);pushScore()};
$('resetBtn').onclick=()=>{Object.assign(st,{h:0,a:0,sec:0,half:1,run:false});pushScore()};
setInterval(()=>{if(isHost&&st.run){st.sec++;pushScore()}},1000);

/* ---------- botones generales ---------- */
const noLib='No se pudo cargar la conexión. Revisa tu internet y recarga la página.';
$('createBtn').onclick=()=>{if(!window.Peer)return lobbyMsg(noLib);if(!peer||!inRoom)createRoom()};
$('joinForm').onsubmit=e=>{e.preventDefault();if(!window.Peer)return lobbyMsg(noLib);joinRoom($('codeIn').value)};
$('shareBtn').onclick=share;
$('lockBtn').onclick=toggleLock;
$('fsBtn').onclick=()=>{try{document.fullscreenElement?document.exitFullscreen():$('stage').requestFullscreen().catch(()=>{})}catch(e){}};
$('inviteBtn').onclick=()=>{
  const text='¡Vamos a ver el partido! Entra aquí: '+inviteLink()+'  (código '+roomCode+')';
  const done=()=>{$('inviteBtn').textContent='Invitación copiada';setTimeout(()=>$('inviteBtn').textContent='Copiar invitación',1800)};
  if(navigator.clipboard)navigator.clipboard.writeText(text).then(done).catch(()=>onMsg({t:'sys',text:'Copia esto: '+text}));
  else onMsg({t:'sys',text:'Copia esto: '+text});
};
$('leaveBtn').onclick=()=>{
  try{stopShare();peer&&peer.destroy()}catch(e){}
  try{history.replaceState(null,'',location.pathname)}catch(e){}
  location.reload();
};
window.addEventListener('beforeunload',e=>{
  if(isHost&&inRoom&&Object.keys(guests).length){e.preventDefault();e.returnValue=''}
});
window.addEventListener('pagehide',()=>{try{peer&&peer.destroy()}catch(e){}});
document.addEventListener('keydown',e=>{
  if(!inRoom||e.target.tagName==='INPUT')return;
  if(e.key==='1')goal('h',1);
  else if(e.key==='2')goal('a',1);
  else if(e.key.toLowerCase()==='f')$('fsBtn').click();
});
renderScore();
})();
