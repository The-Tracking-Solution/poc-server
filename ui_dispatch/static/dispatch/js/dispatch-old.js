const channels=JSON.parse(document.querySelector("#dispatch-poc-channels").textContent);
const units=JSON.parse(document.querySelector("#dispatch-units").textContent);
const selected=new Set(),settings=new Map(),connections=new Map(),unitState=new Map(),channelState=new Map(),clientId=crypto.randomUUID();
let mic=null,currentTile=null,monitor=null,emergency=null,radioPowered=true,capturingHotkey=null,pttKeyDown=false,emergencyBlinkTimer=null;
const savedRadio=JSON.parse(localStorage.getItem("dispatchRadioSettings")||"{}");
let masterVolume=Number.isFinite(savedRadio.masterVolume)?savedRadio.masterVolume:100;
let pttHotkeyCode=savedRadio.pttHotkey||"";
let radioMuted=!!savedRadio.radioMuted;
let previousVolume=Number.isFinite(savedRadio.previousVolume)?savedRadio.previousVolume:masterVolume;
let functionKeys=Array.isArray(savedRadio.functionKeys)&&savedRadio.functionKeys.length===4
 ? savedRadio.functionKeys
 : [
   {action:"channel-toggle",target:channels[0]?.id||""},
   {action:"channel-toggle",target:channels[1]?.id||channels[0]?.id||""},
   {action:"mute-all",target:""},
   {action:"power",target:""}
 ];
const rtc={iceServers:[{urls:"stun:stun.l.google.com:19302"}]};
for(const c of channels)channelState.set(c.id,{current:null,last:null,lastAt:0,dispatcher:false,alarm:false,timer:null});
for(const u of units)unitState.set(u.code,{online:!!u.online,speaking:false,alarm:false,latency:null,channelId:u.channelId});
function s(tile){
 if(!settings.has(tile.dataset.id)){
   const saved=JSON.parse(localStorage.getItem(`dispatchChannel:${tile.dataset.id}`)||"{}");
   settings.set(tile.dataset.id,{mode:saved.mode||"always",left:Number.isFinite(saved.left)?saved.left:100,right:Number.isFinite(saved.right)?saved.right:100,hotkey:saved.hotkey||""});
 }
 return settings.get(tile.dataset.id);
}
function saveChannel(tile){localStorage.setItem(`dispatchChannel:${tile.dataset.id}`,JSON.stringify(s(tile)))}
function saveRadio(){localStorage.setItem("dispatchRadioSettings",JSON.stringify({masterVolume,pttHotkey:pttHotkeyCode,functionKeys,radioMuted,previousVolume}))}
function hotkeyLabel(code){
 if(!code)return "Niet toegewezen";
 const labels={Space:"Spatie",Enter:"Enter",Escape:"Escape",Tab:"Tab",Backspace:"Backspace",ArrowUp:"Pijl omhoog",ArrowDown:"Pijl omlaag",ArrowLeft:"Pijl links",ArrowRight:"Pijl rechts"};
 if(labels[code])return labels[code];
 if(code.startsWith("Numpad"))return code.replace("Numpad","Numpad ");
 if(code.startsWith("Key"))return code.slice(3);
 if(code.startsWith("Digit"))return code.slice(5);
 return code;
}
function icon(tile){
 const st=s(tile),b=tile.querySelector(".audio"),isSelected=tile.classList.contains("selected");
 const symbol=b.querySelector(".material-symbols-rounded");
 b.className="audio";
 if(st.mode==="always"){
   symbol.textContent="volume_up";b.classList.add("always");b.title="Audio mode: Altijd";
 }else if(st.mode==="selected"){
   symbol.textContent="volume_up";b.classList.add("selected-mode");
   if(isSelected)b.classList.add("always");
   b.title=isSelected?"Audio mode: Geselecteerd (actief)":"Audio mode: Geselecteerd";
 }else{
   symbol.textContent="volume_off";b.classList.add("muted");b.title="Audio mode: Gedempt";
 }
 if(currentTile===tile){
   document.querySelectorAll("[data-mode]").forEach(x=>x.classList.toggle("active",x.dataset.mode===st.mode));
 }
 applyAudio();
}
function audible(tile){const st=s(tile);return radioPowered&&(st.mode==="always"||(st.mode==="selected"&&tile.classList.contains("selected")))}
function applyAudio(){
 for(const [id,c] of connections){
   const t=document.querySelector(`.channel-tile[data-id="${id}"]`),st=t?s(t):{left:100,right:100};
   for(const a of c.audios.values()){
     a.muted=!radioPowered||radioMuted||(t?!audible(t):false);
     a.volume=Math.max(0,Math.min(1,((st.left+st.right)/200)*(masterVolume/100)));
   }
 }
}
function setRadioPower(on){
 radioPowered=!!on;
 radioPanel.classList.toggle("off",!radioPowered);
 powerButton.setAttribute("aria-pressed",String(radioPowered));
 if(!radioPowered){if(pttKeyDown){pttKeyDown=false;tx(false)}}
 applyAudio();
 refreshRadioDisplay();
}
function ensureRadioOn(){if(!radioPowered)setRadioPower(true)}
function fitRadioDisplayText(){
 const body=radioDisplay.querySelector(".display-body");
 const primary=radioDisplay.querySelector(".display-primary");
 const secondary=radioDisplay.querySelector(".display-secondary");
 if(!body||!primary)return;

 const primaryMax=52;
 const primaryMin=18;
 const secondaryMax=secondary?.classList.contains("multiple")?22:25;
 const secondaryMin=14;

 let scale=1;
 primary.style.fontSize=`${primaryMax}px`;
 if(secondary)secondary.style.fontSize=`${secondaryMax}px`;

 const overflows=()=>(
   body.scrollHeight>body.clientHeight+1||
   body.scrollWidth>body.clientWidth+1||
   primary.scrollWidth>primary.clientWidth+1||
   (secondary&&secondary.scrollWidth>secondary.clientWidth+1)
 );

 while(scale>0.35&&overflows()){
   scale-=0.03;
   primary.style.fontSize=`${Math.max(primaryMin,primaryMax*scale)}px`;
   if(secondary){
     secondary.style.fontSize=`${Math.max(secondaryMin,secondaryMax*scale)}px`;
   }
 }

 body.classList.toggle("display-overflow",overflows());
}

function renderRadioDisplay(mode,header,primary,secondary=""){
 radioDisplay.className=`display ${mode}`;
 const secondaryClass=secondary&&secondary.length>28?"display-secondary multiple":"display-secondary";
 radioDisplay.innerHTML=`<div class="display-header">${header}</div><div class="display-body"><div class="display-primary">${primary}</div>${secondary?`<div class="${secondaryClass}">${secondary}</div>`:""}</div>`;
 requestAnimationFrame(fitRadioDisplayText);
}
function selectedDisplay(){
 const arr=channels.filter(c=>selected.has(c.id));
 if(!emergency&&!isTransmitting()&&!activeReception()){
   renderRadioDisplay("idle","Geselecteerde pocChannels",arr.length?arr.map(c=>c.name).join(" · "):"Geen selectie");
 }
 document.querySelector("#dispatchPtt").disabled=!arr.length;
 document.querySelectorAll("[data-channel-card]").forEach(card=>{
   card.classList.toggle("channel-selected",selected.has(card.dataset.channelCard));
 });
 applyAudio();
}
function isTransmitting(){return [...channelState.values()].some(st=>st.dispatcher)}
function activeReception(){
 for(const [channelId,st] of channelState){
   if(st.current&&!st.dispatcher&&!st.alarm){
     const channel=channels.find(c=>c.id===channelId);
     return channel?{channel,unit:st.current}:null;
   }
 }
 return null;
}

function startEmergencyBlink(){
 if(emergencyBlinkTimer)return;
 document.body.classList.remove("emergency-phase-on");
 emergencyBlinkTimer=setInterval(()=>{
   document.body.classList.toggle("emergency-phase-on");
 },450);
}
function stopEmergencyBlink(){
 if(emergencyBlinkTimer){
   clearInterval(emergencyBlinkTimer);
   emergencyBlinkTimer=null;
 }
 document.body.classList.remove("emergency-phase-on");
}
function sendMonitorCommand(payload){
 if(monitor&&monitor.readyState===WebSocket.OPEN){
   monitor.send(JSON.stringify(payload));
 }
}
function acceptEmergency(){
 if(!emergency)return;
 emergency.accepted=true;
 stopEmergencyBlink();
 sendMonitorCommand({
   type:"alarm_acknowledge",
   unit:emergency.unit,
   channel_id:emergency.channelId
 });
 tileUpdate(emergency.channelId);
 overview();
 refreshRadioDisplay();
}
function clearEmergency(){
 if(!emergency)return;
 const cleared={...emergency};
 stopEmergencyBlink();

 const unit=unitState.get(cleared.unit);
 if(unit){
   unit.alarm=false;
   unit.speaking=false;
 }
 const channel=channelState.get(cleared.channelId);
 if(channel){
   channel.alarm=false;
   channel.dispatcher=false;
   if(channel.current===cleared.unit)channel.current=null;
 }

 const connection=connections.get(cleared.channelId);
 if(connection){
   connection.track.enabled=false;
   send(connection,{type:"speaking",speaking:false});
 }
 dispatchPtt.classList.remove("active");
 pttKeyDown=false;
 emergency=null;

 sendMonitorCommand({
   type:"alarm_clear",
   unit:cleared.unit,
   channel_id:cleared.channelId
 });

 tileUpdate(cleared.channelId);
 overview();
 selectedDisplay();
 applyAudio();
}

function refreshRadioDisplay(){
 if(!radioPowered){
   renderRadioDisplay("idle","RADIO UIT","Alle kanalen gedempt");
   radioPanel.classList.add("off");
   return;
 }
 radioPanel.classList.remove("off");
 if(emergency){
   renderRadioDisplay(emergency.accepted?"emergency acknowledged":"emergency","NOODOPROEP",emergency.unit,emergency.channelName);
   return;
 }
 const transmitting=channels.filter(c=>channelState.get(c.id)?.dispatcher);
 if(transmitting.length){
   renderRadioDisplay("transmitting","ZENDEN",transmitting.map(c=>c.name).join(" · "));
   return;
 }
 const reception=activeReception();
 if(reception){
   renderRadioDisplay("receiving","ONTVANGST",reception.channel.name,reception.unit);
   return;
 }
 selectedDisplay();
}
function setEmergency(unitCode,channelId,active){
 const channel=channels.find(c=>c.id===channelId);
 if(active&&channel){
   const isSame=emergency&&emergency.unit===unitCode&&emergency.channelId===channelId;
   emergency={
     unit:unitCode,
     channelId,
     channelName:channel.name,
     accepted:isSame?!!emergency.accepted:false
   };
   if(!emergency.accepted){
     selected.clear();
     selected.add(channelId);
     document.querySelectorAll(".channel-tile").forEach(tile=>{
       tile.classList.toggle("selected",tile.dataset.id===channelId);
       icon(tile);
     });
     startEmergencyBlink();
   }
   document.querySelector("#dispatchPtt").disabled=false;
 }else if(emergency&&emergency.unit===unitCode){
   clearEmergency();
   return;
 }
 tileUpdate(channelId);
 overview();
 refreshRadioDisplay();
}
document.querySelectorAll(".tile").forEach(tile=>{s(tile);icon(tile);tile.onclick=e=>{if(e.target.closest("button"))return;if(emergency&&!emergency.accepted&&tile.classList.contains("channel-tile"))return;tile.classList.toggle("selected");if(tile.classList.contains("channel-tile")){if(tile.classList.contains("selected")){ensureRadioOn();selected.add(tile.dataset.id)}else selected.delete(tile.dataset.id);selectedDisplay()}icon(tile)};tile.querySelector(".audio").onclick=e=>{e.stopPropagation();const st=s(tile);st.mode=st.mode==="always"?"selected":st.mode==="selected"?"muted":"always";icon(tile)};tile.querySelector(".settings").onclick=e=>{e.stopPropagation();currentTile=tile;const st=s(tile);document.querySelector("#modalTitle").textContent=tile.dataset.name;leftVolume.value=st.left;rightVolume.value=st.right;leftValue.value=st.left;rightValue.value=st.right;channelHotkey.textContent=hotkeyLabel(st.hotkey);document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("active",b.dataset.mode===st.mode));modal.showModal()}});
modalClose.onclick=()=>modal.close();for(const id of ["leftVolume","rightVolume"])document.querySelector("#"+id).oninput=e=>{if(!currentTile)return;const key=id==="leftVolume"?"left":"right";s(currentTile)[key]=Number(e.target.value);saveChannel(currentTile);document.querySelector("#"+(key==="left"?"leftValue":"rightValue")).value=e.target.value;applyAudio();renderAssignedChannels()};
document.querySelectorAll("[data-mode]").forEach(b=>b.onclick=()=>{
 if(!currentTile)return;
 s(currentTile).mode=b.dataset.mode;
 saveChannel(currentTile);
 icon(currentTile);
 renderAssignedChannels();
});

function beginHotkeyCapture(target){
 capturingHotkey=target;
 target.classList.add("recording");
 target.textContent="Druk op een toets…";
}
function endHotkeyCapture(){
 document.querySelectorAll(".hotkey-input.recording").forEach(x=>x.classList.remove("recording"));
 capturingHotkey=null;
}
channelHotkey.onclick=()=>beginHotkeyCapture(channelHotkey);
clearChannelHotkey.onclick=()=>{if(currentTile){s(currentTile).hotkey="";saveChannel(currentTile);channelHotkey.textContent="Niet toegewezen";renderAssignedChannels()}};
document.querySelector('#pttHotkey').onclick=()=>beginHotkeyCapture(document.querySelector('#pttHotkey'));
clearPttHotkey.onclick=()=>{pttHotkeyCode="";saveRadio();document.querySelector("#pttHotkey").textContent="Niet toegewezen"};
powerButton.onclick=()=>setRadioPower(!radioPowered);
radioSettingsButton.onclick=()=>{document.querySelector("#pttHotkey").textContent=hotkeyLabel(pttHotkeyCode);masterVolume.value=masterVolume;masterVolumeValue.value=masterVolume;renderAssignedChannels();renderFunctionKeySettings();updateFunctionKeyLabels();radioSettingsModal.showModal()};
radioSettingsClose.onclick=()=>radioSettingsModal.close();
function setMasterVolume(value){
 masterVolume=Math.max(0,Math.min(100,Number(value)));
 masterVolume.value=masterVolume;
 masterVolumeValue.value=masterVolume;
 frontMasterVolume.value=masterVolume;

 saveRadio();
 applyAudio();
}
masterVolume.oninput=e=>setMasterVolume(e.target.value);
frontMasterVolume.oninput=e=>{
 radioMuted=false;
 setMasterVolume(e.target.value);
 updateSpeakerMuteState();
};

const functionActionNames={
 "none":"Niet ingesteld",
 "channel-toggle":"Channel selecteren",
 "channel-audio":"Audio mode wisselen",
 "mute-all":"Alles dempen",
 "power":"Radio aan/uit",
 "clear-emergency":"Noodoproep wissen",
 "ptt":"PTT"
};

function functionKeyCaption(config){
 if(!config||config.action==="none")return "Niet ingesteld";
 if(config.action==="channel-toggle"||config.action==="channel-audio"){
   return channels.find(channel=>channel.id===config.target)?.name||"Kies Channel";
 }
 return functionActionNames[config.action]||config.action;
}

function updateFunctionKeyLabels(){
 document.querySelectorAll("[data-function-key]").forEach(button=>{
   const index=Number(button.dataset.functionKey);
   const span=button.querySelector("span");
   if(span){
     const label=functionKeyCaption(functionKeys[index]);
     span.textContent=label==="Niet ingesteld"?"-":label;
   }
 });
}

function setAllChannelsMuted(){
 document.querySelectorAll(".channel-tile").forEach(tile=>{
   s(tile).mode="muted";
   saveChannel(tile);
   icon(tile);
 });
 applyAudio();
 renderAssignedChannels();
}

function cycleChannelAudioMode(tile){
 const modes=["always","selected","muted"];
 const state=s(tile);
 state.mode=modes[(modes.indexOf(state.mode)+1)%modes.length];
 saveChannel(tile);
 icon(tile);
 applyAudio();
 renderAssignedChannels();
}

function runFunctionKey(index,pressed=true){
 const config=functionKeys[index];
 if(!config||config.action==="none")return;
 if(!radioPowered&&config.action!=="power")return;

 const tile=config.target
   ? document.querySelector(`.channel-tile[data-id="${config.target}"]`)
   : null;

 if(config.action==="channel-toggle"&&pressed&&tile){
   ensureRadioOn();
   tile.click();
 }else if(config.action==="channel-audio"&&pressed&&tile){
   cycleChannelAudioMode(tile);
 }else if(config.action==="mute-all"&&pressed){
   setAllChannelsMuted();
 }else if(config.action==="power"&&pressed){
   setRadioPower(!radioPowered);
 }else if(config.action==="clear-emergency"&&pressed&&emergency){
   clearEmergency();
 }else if(config.action==="ptt"){
   tx(pressed);
 }
}

function renderFunctionKeySettings(){
 const actionOptions=Object.entries(functionActionNames)
   .map(([value,label])=>`<option value="${value}">${label}</option>`)
   .join("");
 const channelOptions=channels
   .map(channel=>`<option value="${channel.id}">${channel.name}</option>`)
   .join("");

 document.querySelectorAll("[data-fn-action]").forEach(select=>{
   const index=Number(select.dataset.fnAction);
   select.innerHTML=actionOptions;
   select.value=functionKeys[index]?.action||"none";
   select.onchange=()=>{
     functionKeys[index]={
       action:select.value,
       target:functionKeys[index]?.target||channels[0]?.id||""
     };
     saveRadio();
     renderFunctionKeySettings();
     updateFunctionKeyLabels();
   };
 });

 document.querySelectorAll("[data-fn-target]").forEach(select=>{
   const index=Number(select.dataset.fnTarget);
   const action=functionKeys[index]?.action||"none";
   const usesChannel=action==="channel-toggle"||action==="channel-audio";
   select.innerHTML=usesChannel
     ? channelOptions
     : '<option value="">Niet van toepassing</option>';
   select.disabled=!usesChannel;
   select.value=usesChannel
     ? (functionKeys[index]?.target||channels[0]?.id||"")
     : "";
   select.onchange=()=>{
     functionKeys[index].target=select.value;
     saveRadio();
     updateFunctionKeyLabels();
   };
 });
}

document.querySelectorAll("[data-function-key]").forEach(button=>{
 const index=Number(button.dataset.functionKey);

 button.addEventListener("pointerdown",event=>{
   event.preventDefault();
   button.classList.add("active");
   runFunctionKey(index,true);
 });

 ["pointerup","pointerleave","pointercancel"].forEach(name=>{
   button.addEventListener(name,event=>{
     event.preventDefault();
     button.classList.remove("active");
     if(functionKeys[index]?.action==="ptt"){
       runFunctionKey(index,false);
     }
   });
 });
});

function renderAssignedChannels(){
 assignedChannelsBody.innerHTML=channels.map(ch=>{
   const tile=document.querySelector(`.channel-tile[data-id="${ch.id}"]`),st=s(tile);
   return `<tr data-settings-channel="${ch.id}"><td>${ch.name}</td><td><select data-table-mode><option value="always"${st.mode==="always"?" selected":""}>Altijd</option><option value="selected"${st.mode==="selected"?" selected":""}>Geselecteerd</option><option value="muted"${st.mode==="muted"?" selected":""}>Gedempt</option></select></td><td><input data-table-left type="range" min="0" max="100" value="${st.left}"></td><td><input data-table-right type="range" min="0" max="100" value="${st.right}"></td><td>${hotkeyLabel(st.hotkey)}</td></tr>`;
 }).join("");
 assignedChannelsBody.querySelectorAll("tr").forEach(row=>{
   const tile=document.querySelector(`.channel-tile[data-id="${row.dataset.settingsChannel}"]`);
   row.querySelector("[data-table-mode]").onchange=e=>{s(tile).mode=e.target.value;saveChannel(tile);icon(tile)};
   row.querySelector("[data-table-left]").oninput=e=>{s(tile).left=Number(e.target.value);saveChannel(tile);applyAudio()};
   row.querySelector("[data-table-right]").oninput=e=>{s(tile).right=Number(e.target.value);saveChannel(tile);applyAudio()};
 });
}
function toggleChannelByHotkey(code){
 const tile=[...document.querySelectorAll(".channel-tile")].find(t=>s(t).hotkey===code);
 if(!tile)return false;
 ensureRadioOn();
 tile.click();
 return true;
}
window.addEventListener("keydown",e=>{
 if(capturingHotkey){
   e.preventDefault();e.stopPropagation();
   const code=e.code;
   if(capturingHotkey===channelHotkey&&currentTile){s(currentTile).hotkey=code;saveChannel(currentTile);channelHotkey.textContent=hotkeyLabel(code);renderAssignedChannels()}
   if(capturingHotkey===document.querySelector("#pttHotkey")){pttHotkeyCode=code;saveRadio();document.querySelector("#pttHotkey").textContent=hotkeyLabel(code)}
   endHotkeyCapture();return;
 }
 if(!radioPowered||e.repeat||["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName))return;
 if(pttHotkeyCode&&e.code===pttHotkeyCode){e.preventDefault();pttKeyDown=true;tx(true);return}
 if(toggleChannelByHotkey(e.code))e.preventDefault();
},true);
window.addEventListener("keyup",e=>{if(radioPowered&&pttHotkeyCode&&e.code===pttHotkeyCode&&pttKeyDown){e.preventDefault();pttKeyDown=false;tx(false)}},true);


function updateSpeakerMuteState(){
 const button=document.querySelector("#speakerMuteButton");
 if(!button)return;
 button.classList.toggle("muted",radioMuted);
 button.setAttribute("aria-pressed",String(radioMuted));
 button.querySelector(".material-symbols-rounded").textContent=radioMuted?"volume_off":"volume_up";
 const slider=document.querySelector("#frontMasterVolume");
 if(slider)slider.value=radioMuted?0:masterVolume;
}
document.querySelector("#speakerMuteButton").onclick=()=>{
 if(radioMuted){
   radioMuted=false;
   masterVolume=Math.max(1,previousVolume||100);
 }else{
   previousVolume=masterVolume>0?masterVolume:(previousVolume||100);
   radioMuted=true;
 }
 saveRadio();
 updateSpeakerMuteState();
 applyAudio();
};

document.querySelectorAll(".tab").forEach(tab=>tab.onclick=()=>{
 document.querySelectorAll(".tab").forEach(item=>item.classList.toggle("active",item===tab));
 const showChannels=tab.dataset.view==="channels";
 channelsSection.hidden=!showChannels;
 unitsSection.hidden=showChannels;
});
search.oninput=e=>{const q=e.target.value.toLowerCase();document.querySelectorAll(".tile").forEach(t=>t.hidden=!t.dataset.search.includes(q))};
function send(c,d){if(c.socket.readyState===WebSocket.OPEN)c.socket.send(JSON.stringify(d))}
async function media(){if(!mic)mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false})}
async function peer(c,id){if(c.peers.has(id))return c.peers.get(id);const pc=new RTCPeerConnection(rtc);c.peers.set(id,pc);pc.addTrack(c.track,c.stream);pc.onicecandidate=e=>e.candidate&&send(c,{type:"ice",target:id,candidate:e.candidate});pc.ontrack=e=>{let a=c.audios.get(id);if(!a){a=document.createElement("audio");a.autoplay=true;audioRoot.appendChild(a);c.audios.set(id,a)}a.srcObject=e.streams[0];applyAudio()};return pc}
async function offer(c,id){const pc=await peer(c,id),o=await pc.createOffer();await pc.setLocalDescription(o);send(c,{type:"description",target:id,description:pc.localDescription})}
async function connectChannel(ch){await media();const track=mic.getAudioTracks()[0].clone();track.enabled=false;const c={channelId:ch.id,clientId:`dispatch-${clientId}-${ch.id}`,track,stream:new MediaStream([track]),peers:new Map(),pending:new Map(),audios:new Map(),socket:null};const protocol=location.protocol==="https:"?"wss":"ws";c.socket=new WebSocket(`${protocol}://${location.host}/ws/voice/${ch.id}/DISPATCH/?client_id=${c.clientId}&dispatch=1`);c.socket.onmessage=async e=>{const m=JSON.parse(e.data);if(m.type==="participant_joined"){await offer(c,m.sender);return}if(m.type==="participant_left"){c.peers.get(m.sender)?.close();c.peers.delete(m.sender);c.audios.get(m.sender)?.remove();c.audios.delete(m.sender);return}if(m.target&&m.target!==c.clientId)return;if(m.type==="description"){const pc=await peer(c,m.sender);await pc.setRemoteDescription(m.description);for(const x of c.pending.get(m.sender)||[])await pc.addIceCandidate(x);c.pending.delete(m.sender);if(m.description.type==="offer"){const a=await pc.createAnswer();await pc.setLocalDescription(a);send(c,{type:"description",target:m.sender,description:pc.localDescription})}}else if(m.type==="ice"){const pc=await peer(c,m.sender);if(pc.remoteDescription)await pc.addIceCandidate(m.candidate);else{const q=c.pending.get(m.sender)||[];q.push(m.candidate);c.pending.set(m.sender,q)}}};connections.set(ch.id,c)}
function tileUpdate(id){
 const st=channelState.get(id),t=document.querySelector(`.channel-tile[data-id="${id}"]`);
 if(!t)return;
 const accepted=!!(emergency&&emergency.accepted&&emergency.channelId===id);
 t.classList.toggle("receiving",!!st.current&&!st.dispatcher&&!st.alarm);
 t.classList.toggle("transmitting",st.dispatcher&&!st.alarm);
 t.classList.toggle("alarm",st.alarm);
 t.classList.toggle("alarm-accepted",accepted);
 t.querySelector(".secondary").textContent=st.current||((Date.now()-st.lastAt)<60000?st.last:"")||"";
 refreshRadioDisplay();
}
function stopUnit(id,code){const st=channelState.get(id);st.current=null;st.last=code;st.lastAt=Date.now();clearTimeout(st.timer);st.timer=setTimeout(()=>{if(Date.now()-st.lastAt>=60000){st.last=null;tileUpdate(id)}},60050);tileUpdate(id)}
function overview(){
 for(const ch of channels){
   const rows=[...unitState].filter(([,v])=>v.channelId===ch.id&&v.online);
   document.querySelector(`[data-list="${ch.id}"]`).innerHTML=rows.length?rows.map(([code,v])=>{
     const isCurrent=!!(emergency&&emergency.unit===code&&emergency.channelId===ch.id);
     const accepted=!!(isCurrent&&emergency.accepted);
     const action=v.alarm&&isCurrent
       ? `<div class="emergency-actions">${accepted
           ? `<button class="emergency-action clear" data-emergency-clear="${code}" data-channel="${ch.id}">Wissen</button>`
           : `<button class="emergency-action" data-emergency-accept="${code}" data-channel="${ch.id}">Accepteren</button>`
         }</div>`
       : `<span class="latency">${v.latency==null?"":Math.round(v.latency)+" ms"}</span>`;
     return `<div class="unit-row ${v.alarm?"emergency":""} ${accepted?"accepted":""}">
       <span class="dot ${v.alarm?"alarm":v.speaking?"speaking":"online"}"></span>
       <div><strong>${code}</strong><div class="meta">${v.alarm?(accepted?"NOODOPROEP GEACCEPTEERD":"NOODOPROEP"):v.speaking?"Zendt":"Online"}</div></div>
       ${action}
     </div>`;
   }).join(""):'<div class="empty">Geen actieve Units</div>';
 }
}

document.querySelector("#unitsSection").addEventListener("click",event=>{
 const accept=event.target.closest("[data-emergency-accept]");
 if(accept){
   event.preventDefault();
   acceptEmergency();
   return;
 }
 const clear=event.target.closest("[data-emergency-clear]");
 if(clear){
   event.preventDefault();
   clearEmergency();
 }
});

function monitorConnect(){const protocol=location.protocol==="https:"?"wss":"ws";monitor=new WebSocket(`${protocol}://${location.host}/ws/monitor/`);monitor.onmessage=e=>{const m=JSON.parse(e.data),u=unitState.get(m.unit),c=channelState.get(m.channel_id);if(m.type==="unit_online"&&u){u.online=true;u.channelId=m.channel_id}if(m.type==="unit_offline"&&u){u.online=false;u.speaking=false}if(m.type==="unit_latency"&&u)u.latency=m.latency_ms;if(m.type==="unit_alarm"&&u&&c){u.alarm=m.active;c.alarm=[...unitState.values()].some(x=>x.channelId===m.channel_id&&x.alarm);tileUpdate(m.channel_id);setEmergency(m.unit,m.channel_id,m.active)}if(m.type==="unit_speaking"&&u&&c){u.speaking=m.speaking;if(m.speaking){c.current=m.unit;c.last=m.unit;c.lastAt=Date.now()}else if(c.current===m.unit)stopUnit(m.channel_id,m.unit);tileUpdate(m.channel_id)}overview()};monitor.onclose=()=>setTimeout(monitorConnect,2000)}
function tx(active){
 if(active&&!radioPowered)return;
 let transmitting=false;
 for(const [id,c] of connections){
   const enabled=!!active&&selected.has(id);
   c.track.enabled=enabled;
   send(c,{type:"speaking",speaking:enabled});
   const st=channelState.get(id);
   if(st)st.dispatcher=enabled;
   if(enabled)transmitting=true;
   tileUpdate(id);
 }
 dispatchPtt.classList.toggle("active",transmitting);
 refreshRadioDisplay();
}
function startPtt(event){
 if(event)event.preventDefault();
 if(dispatchPtt.disabled||!radioPowered)return;
 pttKeyDown=true;
 try{dispatchPtt.setPointerCapture?.(event?.pointerId)}catch(_){}
 tx(true);
}
function stopPtt(event){
 if(event)event.preventDefault();
 if(!pttKeyDown&&!dispatchPtt.classList.contains("active"))return;
 pttKeyDown=false;
 tx(false);
}
dispatchPtt.addEventListener("pointerdown",startPtt);
dispatchPtt.addEventListener("pointerup",stopPtt);
dispatchPtt.addEventListener("pointercancel",stopPtt);
dispatchPtt.addEventListener("lostpointercapture",stopPtt);
dispatchPtt.addEventListener("keydown",event=>{
 if((event.code==="Space"||event.code==="Enter")&&!event.repeat)startPtt(event);
});
dispatchPtt.addEventListener("keyup",event=>{
 if(event.code==="Space"||event.code==="Enter")stopPtt(event);
});
window.addEventListener("pointerup",stopPtt);
window.addEventListener("blur",()=>stopPtt());
window.addEventListener("resize",()=>requestAnimationFrame(fitRadioDisplayText));
setInterval(()=>clock.textContent=new Date().toLocaleTimeString("nl-NL"),1000);
setRadioPower(true);
document.querySelector("#pttHotkey").textContent=hotkeyLabel(pttHotkeyCode);
masterVolume.value=masterVolume;
masterVolumeValue.value=masterVolume;
frontMasterVolume.value=masterVolume;
renderAssignedChannels();
renderFunctionKeySettings();
updateFunctionKeyLabels();
updateSpeakerMuteState();
overview();
