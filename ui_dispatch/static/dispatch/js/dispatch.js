const channels=JSON.parse(document.querySelector("#dispatch-poc-channels").textContent);
const units=JSON.parse(document.querySelector("#dispatch-units").textContent);
const dispatchServerSettings=JSON.parse(document.querySelector("#dispatch-radio-settings")?.textContent||"{}");
const dispatchUserStatuses=JSON.parse(document.querySelector("#dispatch-user-statuses")?.textContent||"[]");
const dispatchButtonDefinitions=JSON.parse(document.querySelector("#dispatch-buttons")?.textContent||'{"radio":[],"sidebar":[]}');
const selected=new Set(),settings=new Map(),connections=new Map(),unitState=new Map(),channelState=new Map(),clientId=crypto.randomUUID();
let mic=null,currentTile=null,monitor=null,emergency=null,dismissedEmergencyChannelId=null,radioPowered=false,dispatchRadioViewActive=true,capturingHotkey=null,pttKeyDown=false,emergencyBlinkTimer=null,priorityChannelId=null,priorityUntil=0,priorityTimer=null,lockedMasterChannelId=null;
let dispatchAudioContext=null,dispatchControlCredentials=null,txPermissionMode="conservative";
let dispatchMicSource=null,dispatchMicProcessor=null,dispatchTxGeneration=0,dispatchTxRequested=false,dispatchTxTransition=Promise.resolve(),pttDisplayStatus=null;
let activeCallRequest=null,callRequestsRefreshTimer=null;
let callRequestAlarmTimer=null,callRequestAlarmGeneration=0,activeP1AudioChannelId=null;
const callRequestSeen=new Set(),p1CallRequestStates=new Map();
let dispatchReconnectRunning=false,connectionLostTimer=null,dispatchReconnectTimer=null,channelLinksReconnectTimer=null,dispatchHadConnection=false,dispatchInitialConnectPending=true;
const pendingChannelLinkReconnectIds=new Set();
let dispatchErrorOscillator=null,dispatchErrorGain=null;
let dispatchBusyBuzzOscillator=null,dispatchBusyBuzzGain=null,dispatchBusyBuzzTimer=null,dispatchBusyBuzzGeneration=-1;
const dispatchErrorLog=[];
function logDispatchEvent(level,event,details={}){
 const entry={timestamp:new Date().toISOString(),level,event,...details};dispatchErrorLog.push(entry);
 if(dispatchErrorLog.length>1000)dispatchErrorLog.splice(0,dispatchErrorLog.length-1000);
 try{localStorage.setItem("dispatchErrorLog",JSON.stringify(dispatchErrorLog.slice(-500)))}catch(_){}
}
try{const stored=JSON.parse(localStorage.getItem("dispatchErrorLog")||"[]");if(Array.isArray(stored))dispatchErrorLog.push(...stored.slice(-500))}catch(_){}
const AUDIO_SAMPLE_RATE=16000;
const WS_PING_INTERVAL_MS=10000;
const AUDIO_FOCUS_MS=5000;
const savedRadio=(dispatchServerSettings&&typeof dispatchServerSettings.radio==="object")?dispatchServerSettings.radio:{};
const savedChannels=(dispatchServerSettings&&typeof dispatchServerSettings.channels==="object")?dispatchServerSettings.channels:{};
let masterVolume=Number.isFinite(savedRadio.masterVolume)?savedRadio.masterVolume:100;
let masterLeft=Number.isFinite(savedRadio.masterLeft)?savedRadio.masterLeft:masterVolume;
let masterRight=Number.isFinite(savedRadio.masterRight)?savedRadio.masterRight:masterVolume;
let secondaryAudioVolume=Number.isFinite(savedRadio.secondaryAudioVolume)?savedRadio.secondaryAudioVolume:50;
let pttHotkeyCode=savedRadio.pttHotkey||"";
let muteHotkeyCode=savedRadio.muteHotkey||"";
let radioMuted=!!savedRadio.radioMuted;
let selectedTxChannelId=String(savedRadio.selectedTxChannelId||"");
const dispatchTxChannelBus=("BroadcastChannel" in window)?new BroadcastChannel(`dispatch-tx-channel:${document.body.dataset.tenantSlug||""}`):null;
let txAcceptToneEnabled=savedRadio.txAcceptToneEnabled!==false;
let keyToneEnabled=savedRadio.keyToneEnabled!==false;
const savedCallRequestAudio=(dispatchServerSettings&&typeof dispatchServerSettings.call_request_audio==="object")?dispatchServerSettings.call_request_audio:{};
const savedP1Audio=(savedCallRequestAudio&&typeof savedCallRequestAudio.priority_1==="object")?savedCallRequestAudio.priority_1:{};
let callRequestAudioEnabled=savedCallRequestAudio.enabled!==false;
let callRequestAudioVolume=Number.isFinite(savedCallRequestAudio.volume)?Math.max(0,Math.min(100,Number(savedCallRequestAudio.volume))):80;
let p1InitialFrequency=Number.isFinite(savedP1Audio.initial_frequency_hz)?Number(savedP1Audio.initial_frequency_hz):520;
let p1MorseDelaySeconds=Number.isFinite(savedP1Audio.morse_delay_seconds)?Math.max(0,Number(savedP1Audio.morse_delay_seconds)):15;
let p1LowFrequency=Number.isFinite(savedP1Audio.low_frequency_hz)?Number(savedP1Audio.low_frequency_hz):520;
let p1HighFrequency=Number.isFinite(savedP1Audio.high_frequency_hz)?Number(savedP1Audio.high_frequency_hz):880;
let callRequestPingCounts={
 2:Number.isFinite(savedCallRequestAudio.priority_2_pings)?Math.max(0,Math.min(12,Number(savedCallRequestAudio.priority_2_pings))):5,
 3:Number.isFinite(savedCallRequestAudio.priority_3_pings)?Math.max(0,Math.min(12,Number(savedCallRequestAudio.priority_3_pings))):4,
 4:Number.isFinite(savedCallRequestAudio.priority_4_pings)?Math.max(0,Math.min(12,Number(savedCallRequestAudio.priority_4_pings))):3,
 5:Number.isFinite(savedCallRequestAudio.priority_5_pings)?Math.max(0,Math.min(12,Number(savedCallRequestAudio.priority_5_pings))):2,
 6:Number.isFinite(savedCallRequestAudio.priority_6_pings)?Math.max(0,Math.min(12,Number(savedCallRequestAudio.priority_6_pings))):1
};
let previousVolume=Number.isFinite(savedRadio.previousVolume)?savedRadio.previousVolume:masterVolume;
function dispatchMasterAudioLevel(){
 return radioMuted?0:Math.max(0,Math.min(1,masterVolume/100));
}
function dispatchLocalGain(value){
 return Math.max(0,Number(value)||0)*dispatchMasterAudioLevel();
}
const rtc={iceServers:[{urls:"stun:stun.l.google.com:19302"}]};
for(const c of channels)channelState.set(c.id,{current:null,currentSlug:null,last:null,lastAt:0,lastActivityAt:0,dispatcher:false,dispatcherDirect:false,linkedVia:false,alarm:false,emergencyUnit:null,emergencyUnits:[],emergencyPriority:null,timer:null});
for(const u of units)unitState.set(u.code,{slug:u.slug,online:!!u.online,speaking:false,alarm:false,latency:null,channelId:u.channelId});
function s(tile){
 if(!settings.has(tile.dataset.id)){
   const saved=savedChannels[tile.dataset.id]||{};
   const migratedMode={always:"primary",selected:"selected-only",muted:"secondary"}[saved.mode]||saved.mode||"primary";
   settings.set(tile.dataset.id,{mode:migratedMode,left:Number.isFinite(saved.left)?saved.left:100,right:Number.isFinite(saved.right)?saved.right:100,hotkey:saved.hotkey||"",group:typeof saved.group==="string"?saved.group:""});
 }
 return settings.get(tile.dataset.id);
}
let dispatchSettingsSaveTimer=null;
let dispatchSettingsPending={};
function mergeSettingsPatch(target,patch){
 for(const [key,value] of Object.entries(patch||{})){
   if(value&&typeof value==="object"&&!Array.isArray(value)){
     target[key]=mergeSettingsPatch(target[key]&&typeof target[key]==="object"&&!Array.isArray(target[key])?target[key]:{},value);
   }else target[key]=value;
 }
 return target;
}
function queueDispatchSettingsSave(patch){
 dispatchSettingsPending=mergeSettingsPatch(dispatchSettingsPending,patch);
 clearTimeout(dispatchSettingsSaveTimer);
 dispatchSettingsSaveTimer=setTimeout(async()=>{
   const pending=dispatchSettingsPending;dispatchSettingsPending={};
   const tenant=encodeURIComponent(document.body.dataset.tenantSlug);
   try{
     const response=await fetch(`/dispatch/${tenant}/api/radio-settings/`,{
       method:"POST",credentials:"same-origin",
       headers:{"Content-Type":"application/json","X-CSRFToken":decodeURIComponent(cookieValue("csrftoken"))},
       body:JSON.stringify({radio_settings:pending}),
     });
     if(!response.ok)throw new Error(`HTTP ${response.status}`);
   }catch(error){
     console.error("Dispatch-instellingen konden niet worden opgeslagen",error);
     logDispatchEvent("error","dispatch_settings_save_failed",{error:error.message});
   }
 },300);
}
function saveChannel(tile){queueDispatchSettingsSave({channels:{[tile.dataset.id]:s(tile)}})}
function saveRadio(){
 queueDispatchSettingsSave({radio:{masterVolume,masterLeft,masterRight,secondaryAudioVolume,pttHotkey:pttHotkeyCode,muteHotkey:muteHotkeyCode,radioMuted,previousVolume,txAcceptToneEnabled,keyToneEnabled}});
}
function saveCallRequestAudio(){
 queueDispatchSettingsSave({call_request_audio:{
   enabled:callRequestAudioEnabled,volume:callRequestAudioVolume,
   priority_1:{enabled:true,initial_frequency_hz:p1InitialFrequency,morse_delay_seconds:p1MorseDelaySeconds,low_frequency_hz:p1LowFrequency,high_frequency_hz:p1HighFrequency},
   priority_2_pings:callRequestPingCounts[2],priority_3_pings:callRequestPingCounts[3],priority_4_pings:callRequestPingCounts[4],priority_5_pings:callRequestPingCounts[5],priority_6_pings:callRequestPingCounts[6]
 }});
}
document.querySelector("#downloadDispatchErrorLog")?.addEventListener("click",()=>{
 const snapshot={generatedAt:new Date().toISOString(),tenant:document.body.dataset.tenantSlug,userAgent:navigator.userAgent,online:navigator.onLine,channels,connections:[...connections].map(([id,c])=>({id,slug:c.channelSlug,readyState:c.socket?.readyState??null,transmitting:c.transmitting,presenceProfile:c.presenceProfile})),events:dispatchErrorLog};
 const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),link=document.createElement("a");
 link.href=url;link.download=`dispatch-foutlog-${document.body.dataset.tenantSlug}-${new Date().toISOString().replaceAll(":","-")}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
document.querySelector("#clearDispatchErrorLog")?.addEventListener("click",()=>{dispatchErrorLog.length=0;localStorage.removeItem("dispatchErrorLog")});
async function dispatchTone(frequency,durationMs,delayMs=0,gainValue=.18){
 const context=await ensureDispatchAudioContext(),oscillator=context.createOscillator(),gain=context.createGain(),start=context.currentTime+delayMs/1000,stop=start+durationMs/1000;
 oscillator.frequency.value=frequency;gain.gain.value=dispatchLocalGain(gainValue);oscillator.connect(gain);gain.connect(context.destination);oscillator.start(start);oscillator.stop(stop);oscillator.onended=()=>{oscillator.disconnect();gain.disconnect()};
}
function playDispatchAcceptTone(){if(txAcceptToneEnabled)void Promise.all([dispatchTone(660,75),dispatchTone(880,75,105)])}
async function startDispatchErrorTone(){if(dispatchErrorOscillator)return;const context=await ensureDispatchAudioContext(),oscillator=context.createOscillator(),gain=context.createGain();oscillator.frequency.value=190;gain.gain.value=dispatchLocalGain(.2);oscillator.connect(gain);gain.connect(context.destination);oscillator.start();dispatchErrorOscillator=oscillator;dispatchErrorGain=gain}
function stopDispatchErrorTone(){try{dispatchErrorOscillator?.stop()}catch(_){}try{dispatchErrorOscillator?.disconnect()}catch(_){}try{dispatchErrorGain?.disconnect()}catch(_){}dispatchErrorOscillator=null;dispatchErrorGain=null}
function playDispatchErrorTone(){if(pttKeyDown)void startDispatchErrorTone();else void dispatchTone(220,450,0,.22)}
function stopDispatchBusyBuzz(){
 clearTimeout(dispatchBusyBuzzTimer);dispatchBusyBuzzTimer=null;
 try{dispatchBusyBuzzOscillator?.stop()}catch(_){}try{dispatchBusyBuzzOscillator?.disconnect()}catch(_){}try{dispatchBusyBuzzGain?.disconnect()}catch(_){}
 dispatchBusyBuzzOscillator=null;dispatchBusyBuzzGain=null;
}
async function startDispatchBusyBuzz(generation){
 // Lage bezet-brom: één keer per PTT-hold, maximaal 1 seconde.
 if(dispatchBusyBuzzGeneration===generation||!dispatchTxRequested)return;
 dispatchBusyBuzzGeneration=generation;
 const context=await ensureDispatchAudioContext();if(!dispatchTxRequested||generation!==dispatchTxGeneration)return;
 const oscillator=context.createOscillator(),gain=context.createGain();oscillator.type="sine";oscillator.frequency.value=190;gain.gain.value=dispatchLocalGain(.2);oscillator.connect(gain);gain.connect(context.destination);
 dispatchBusyBuzzOscillator=oscillator;dispatchBusyBuzzGain=gain;oscillator.start();dispatchBusyBuzzTimer=setTimeout(stopDispatchBusyBuzz,1000);
}
function waitForDispatchFloorWake(c,ms=1000){
 return new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;if(c.floorWakeResolver===finish)c.floorWakeResolver=null;clearTimeout(timer);resolve()};const timer=setTimeout(finish,ms);c.floorWakeResolver=finish});
}
function callRequestGain(){return Math.max(0,Math.min(.35,(callRequestAudioVolume/100)*.24))*dispatchMasterAudioLevel()}
async function waitCallRequestAudio(ms,generation){
 const started=performance.now();
 while(performance.now()-started<ms){if(generation!==callRequestAlarmGeneration)return false;await new Promise(resolve=>setTimeout(resolve,Math.min(60,ms-(performance.now()-started))))}
 return generation===callRequestAlarmGeneration;
}
function callRequestChannelBusy(channelId){
 const state=channelState.get(String(channelId))||channelState.get(channelId),connection=connections.get(String(channelId))||connections.get(channelId);
 return !!(state?.current||state?.dispatcher||state?.priority99||connection?.transmitting);
}
function interruptCallRequestAlarm(channelId=null){
 if(channelId!=null){
   if(activeP1AudioChannelId==null)return;
   if(String(channelId)!==String(activeP1AudioChannelId))return;
 }
 callRequestAlarmGeneration+=1;activeP1AudioChannelId=null;
}
async function playCallRequestTone(frequency,durationMs,generation,gainValue=callRequestGain()){
 if(generation!==callRequestAlarmGeneration)return false;
 const context=await ensureDispatchAudioContext();
 if(generation!==callRequestAlarmGeneration)return false;
 return new Promise(resolve=>{
   const oscillator=context.createOscillator(),gain=context.createGain();
   let finished=false;
   const finish=()=>{if(finished)return;finished=true;try{oscillator.disconnect()}catch(_){}try{gain.disconnect()}catch(_){}resolve(generation===callRequestAlarmGeneration)};
   oscillator.type="sine";oscillator.frequency.value=frequency;gain.gain.value=dispatchLocalGain(gainValue);oscillator.connect(gain);gain.connect(context.destination);oscillator.onended=finish;
   try{oscillator.start();oscillator.stop(context.currentTime+durationMs/1000)}catch(_){finish()}
   const watcher=setInterval(()=>{if(generation!==callRequestAlarmGeneration){clearInterval(watcher);try{oscillator.stop()}catch(_){}finish()}},30);
   setTimeout(()=>{clearInterval(watcher);finish()},durationMs+120);
 });
}
async function playReceptionPing(count){
 if(!dispatchRadioViewActive||!callRequestAudioEnabled||count<=0)return;
 const generation=callRequestAlarmGeneration;
 for(let index=0;index<count;index++){
   if(generation!==callRequestAlarmGeneration||!radioPowered||!dispatchRadioViewActive)return;
   await Promise.all([playCallRequestTone(1046,90,generation,callRequestGain()),playCallRequestTone(1568,70,generation,callRequestGain()*.55)]);
   if(index<count-1&&!(await waitCallRequestAudio(360,generation)))return;
 }
}
async function playMorseSos(channelId,frequency,generation){
 const unit=120,pattern="...---...";
 activeP1AudioChannelId=String(channelId);
 for(let i=0;i<pattern.length;i++){
   if(generation!==callRequestAlarmGeneration||callRequestChannelBusy(channelId))return false;
   const duration=pattern[i]==="-"?unit*3:unit;
   if(!(await playCallRequestTone(frequency,duration,generation)))return false;
   const next=pattern[i+1];
   const gap=(i===2||i===5)?unit*3:unit;
   if(next&&!(await waitCallRequestAudio(gap,generation)))return false;
 }
 activeP1AudioChannelId=null;
 return true;
}
function syncCallRequestAudio(items){
 const activeIds=new Set(items.map(item=>Number(item.id)));
 for(const id of [...p1CallRequestStates.keys()])if(!activeIds.has(id)){p1CallRequestStates.delete(id);interruptCallRequestAlarm()}
 for(const item of items){
   const id=Number(item.id),priority=Number(item.priority),channelId=String(item.channel_id),activatedAt=Number(item.activated_at_ms)||Date.now();
   if(priority===1){
     if(!p1CallRequestStates.has(id))p1CallRequestStates.set(id,{id,channelId,activatedAt,initialPlayed:false,nextHigh:false,running:false});
   }else if(priority>=2&&priority<=6&&!callRequestSeen.has(id)){
     callRequestSeen.add(id);void playReceptionPing(callRequestPingCounts[priority]||0);
   }
 }
 for(const id of [...callRequestSeen])if(!activeIds.has(id))callRequestSeen.delete(id);
}
async function servicePriorityOneAlarm(){
 if(!radioPowered||!dispatchRadioViewActive||!callRequestAudioEnabled)return;
 const alarms=[...p1CallRequestStates.values()].sort((a,b)=>a.activatedAt-b.activatedAt);
 for(const alarm of alarms){
   if(alarm.running)continue;
   if(alarm.initialPlayed&&callRequestChannelBusy(alarm.channelId))continue;
   alarm.running=true;
   const generation=callRequestAlarmGeneration;
   try{
     if(!alarm.initialPlayed){
       activeP1AudioChannelId=alarm.channelId;
       if(await playCallRequestTone(p1InitialFrequency,180,generation))alarm.initialPlayed=true;
       activeP1AudioChannelId=null;
       return;
     }
     const dueAt=alarm.activatedAt+(p1MorseDelaySeconds*1000);
     if(Date.now()<dueAt)return;
     const frequency=alarm.nextHigh?p1HighFrequency:p1LowFrequency;
     const played=await playMorseSos(alarm.channelId,frequency,generation);
     if(played){alarm.nextHigh=!alarm.nextHigh;await waitCallRequestAudio(650,generation)}
     return;
   }finally{alarm.running=false;activeP1AudioChannelId=null}
 }
}
function markCallRequestClaimed(requestId){
 p1CallRequestStates.delete(Number(requestId));callRequestSeen.delete(Number(requestId));interruptCallRequestAlarm();
}
function hotkeyLabel(code){
 if(!code)return "Niet toegewezen";
 const labels={Space:"Spatie",Enter:"Enter",Escape:"Escape",Tab:"Tab",Backspace:"Backspace",ArrowUp:"Pijl omhoog",ArrowDown:"Pijl omlaag",ArrowLeft:"Pijl links",ArrowRight:"Pijl rechts"};
 if(labels[code])return labels[code];
 if(code.startsWith("Numpad"))return code.replace("Numpad","Numpad ");
 if(code.startsWith("Key"))return code.slice(3);
 if(code.startsWith("Digit"))return code.slice(5);
 return code;
}
function setConnectionLost(lost,reconnecting=false){
 const banner=document.querySelector("#connectionLostBanner");if(!banner)return;
 banner.hidden=!lost;banner.classList.toggle("reconnecting",reconnecting);
 const button=banner.querySelector("#reconnectButton");if(button)button.textContent=reconnecting?"Reconnecting…":"Reconnect";
}
function clearDispatchReconnectTimer(){
 if(dispatchReconnectTimer)clearTimeout(dispatchReconnectTimer);
 dispatchReconnectTimer=null;
}
function scheduleDispatchReconnect(){
 if(dispatchReconnectRunning||dispatchReconnectTimer||!navigator.onLine)return;
 dispatchReconnectTimer=setTimeout(()=>{
   dispatchReconnectTimer=null;
   void reconnectDispatch();
 },5000);
}
function updateDispatchConnectionState(){
 const connected=[...connections.values()].some(connection=>connection.socket?.readyState===WebSocket.OPEN);
 if(connected){
   dispatchHadConnection=true;dispatchInitialConnectPending=false;
   clearTimeout(connectionLostTimer);connectionLostTimer=null;clearDispatchReconnectTimer();setConnectionLost(false);return;
 }
 if(dispatchInitialConnectPending)return;
 if(!dispatchControlCredentials&&!dispatchHadConnection)return;
 clearTimeout(connectionLostTimer);
 // Een korte control/WebRTC-dip hoort niet meteen de hele dispatch als verloren
 // verbinding te markeren. Reconnect loopt wel door; de banner komt pas na 15 s.
 connectionLostTimer=setTimeout(()=>{setConnectionLost(true,false);scheduleDispatchReconnect()},15000);
 scheduleDispatchReconnect();
}
function icon(tile){
 const st=s(tile);
 if(currentTile===tile){
   document.querySelectorAll("[data-mode]").forEach(x=>x.classList.toggle("active",x.dataset.mode===st.mode));
 }
 applyAudio();
}
function audible(tile){const st=s(tile);return radioPowered&&(st.mode!=="selected-only"||tile.classList.contains("selected"))}
function channelIsSelectionMuted(channelId){
 const tile=document.querySelector(`.channel-tile[data-id="${channelId}"]`);
 return !!tile&&s(tile).mode==="selected-only"&&!selected.has(channelId)&&!channelState.get(channelId)?.alarm;
}
function emergencyFocusChannel(){
 if(emergency?.channelId)return emergency.channelId;
 return [...channelState].find(([,state])=>state.alarm)?.[0]||null;
}
function schedulePriorityExpiry(){
 clearTimeout(priorityTimer);priorityTimer=null;
 if(!priorityChannelId||!priorityUntil)return;
 priorityTimer=setTimeout(()=>{
   const state=channelState.get(priorityChannelId);
   if(state?.lastActivityAt&&Date.now()-state.lastActivityAt<AUDIO_FOCUS_MS){
     priorityUntil=state.lastActivityAt+AUDIO_FOCUS_MS;return schedulePriorityExpiry();
   }
   if(Date.now()<priorityUntil)return schedulePriorityExpiry();
   priorityChannelId=null;priorityUntil=0;applyAudio();
 },Math.max(20,priorityUntil-Date.now()+20));
}
function activePriorityChannel(){
 if(lockedMasterChannelId)return lockedMasterChannelId;
 const emergencyChannel=emergencyFocusChannel();
 if(emergencyChannel)return emergencyChannel;
 if(!priorityChannelId)return null;
 if(channelIsSelectionMuted(priorityChannelId)){
   clearTimeout(priorityTimer);priorityTimer=null;priorityChannelId=null;priorityUntil=0;
   return null;
 }
 const state=channelState.get(priorityChannelId),recentActivity=state?.lastActivityAt&&Date.now()-state.lastActivityAt<AUDIO_FOCUS_MS;
 if(recentActivity){
   priorityUntil=Math.max(priorityUntil,state.lastActivityAt+AUDIO_FOCUS_MS);
   return priorityChannelId;
 }
 return Date.now()<priorityUntil?priorityChannelId:null;
}
function setAudioPriority(channelId){
 if(!channelId)return;
 priorityChannelId=channelId;priorityUntil=Date.now()+AUDIO_FOCUS_MS;
 schedulePriorityExpiry();
 applyAudio();
}
function clearAudioPriority(){clearTimeout(priorityTimer);priorityTimer=null;priorityChannelId=null;priorityUntil=0;applyAudio()}
function clearAudioPriorityForDeselectedChannel(channelId){
 if(priorityChannelId!==channelId)return;
 clearAudioPriority();
}
function noteChannelActivity(channelId){
 const state=channelState.get(channelId);if(!state)return;
 if(channelIsSelectionMuted(channelId))return;
 state.lastActivityAt=Date.now();
}
function channelAudioProfile(id,tile,focusId){
 const state=channelState.get(id),setting=tile?s(tile):{mode:"primary"};
 if(!radioPowered||!dispatchRadioViewActive||radioMuted)return "muted";
 if(id===lockedMasterChannelId)return "primary";
 if(setting.mode==="selected-only"&&!selected.has(id))return "muted";
 if(focusId)return id===focusId?"primary":"secondary";
 if(setting.mode==="primary")return "primary";
 if(setting.mode==="secondary")return selected.has(id)?"primary":"secondary";
 if(setting.mode==="selected-only")return selected.has(id)?"primary":"muted";
 return "primary";
}
function applyAudio(){
 const focusId=activePriorityChannel();
 document.querySelectorAll(".channel-tile").forEach(t=>{
   const id=t.dataset.id,c=connections.get(id),st=s(t);
   const profile=channelAudioProfile(id,t,focusId);
   const modeVolume=profile==="secondary"?secondaryAudioVolume:100;
   const audibleNow=profile!=="muted";
   const forcedMaster=id===lockedMasterChannelId||channelState.get(id)?.priority99===true;
   const volume=forcedMaster
     ? Math.max(0,Math.min(1,masterVolume/100))
     : Math.max(0,Math.min(1,(((st.left*masterLeft)+(st.right*masterRight))/20000)*(modeVolume/100)));
   if(c?.gain)c.gain.gain.value=audibleNow?volume:0;
   if(c?.livekit)void c.livekit.setReceiveEnabled(audibleNow).catch(()=>{});
   if(c?.socket?.readyState===WebSocket.OPEN&&c.presenceProfile!==profile){
     c.socket.send(JSON.stringify({type:"presence_mode",profile}));
     c.presenceProfile=profile;
   }
   const button=t.querySelector(".audio"),symbol=button?.querySelector(".material-symbols-rounded");
   if(button&&symbol){
     const labels={primary:"Primair volume",secondary:"Secundair volume",muted:"Gedempt"};
     button.classList.remove("audio-primary","audio-secondary","audio-unselected");
     button.classList.add(profile==="primary"?"audio-primary":profile==="secondary"?"audio-secondary":"audio-unselected");
     symbol.textContent=profile==="primary"?"volume_up":profile==="secondary"?"volume_down":"volume_off";
     button.title=`Actueel: ${labels[profile]} · Ingesteld: ${st.mode}`;
     button.setAttribute("aria-label",`Actuele audiostatus: ${labels[profile]}`);
   }
 });
}
function setRadioPower(on){
 radioPowered=!!on;
 radioPanel.classList.toggle("off",!radioPowered);
 const lowerControls=document.querySelector(".dispatch-console-lower");
 lowerControls?.classList.toggle("controls-disabled",!radioPowered);
 if(lowerControls)lowerControls.inert=!radioPowered;
 const communicationCards=document.querySelector(".dispatch-right-column");
 communicationCards?.classList.toggle("controls-disabled",!radioPowered);
 if(communicationCards)communicationCards.inert=!radioPowered;
 [radioSettingsButton,speakerMuteButton,frontLeftVolume,frontRightVolume].forEach(control=>control.disabled=!radioPowered);
 document.querySelectorAll(".dispatch-config-button:not(.sidebar-system-button)").forEach(button=>button.disabled=!radioPowered);
 dispatchPtt.disabled=!radioPowered||!dispatchRadioViewActive||!selected.size;
 powerButton.setAttribute("aria-pressed",String(radioPowered));
 if(!radioPowered){pttKeyDown=false;void tx(false);clearAudioPriority();interruptCallRequestAlarm()}
 else {
   void refreshCallRequests();
   if(!selected.size&&selectedTxChannelId){
     // Herstel de laatst via Dispatch/Map gekozen TX-channel zodra de radio aan gaat.
     selectDispatchTxChannel(selectedTxChannelId,{persist:false,powerOn:false});
   }
 }
 // Publiceer ook bewust radio-uit direct; de dispatcher-card wordt dan rood
 // zonder te wachten op het volgende heartbeatinterval.
 void heartbeatDispatchSession().then(()=>refreshAddressBookConnectionStatus());
 applyAudio();
 refreshRadioDisplay();
}
function ensureRadioOn(){if(!radioPowered)setRadioPower(true)}
function fitRadioDisplayText(){
 const channelCells=radioDisplay.querySelectorAll(".radio-display-channels");
 if(channelCells.length){
   channelCells.forEach(cell=>{
     const max=Math.max(10,Math.min(32,cell.clientHeight*.42));
     let size=max;
     cell.style.fontSize=`${size}px`;
     while(size>9&&(cell.scrollHeight>cell.clientHeight+1||cell.scrollWidth>cell.clientWidth+1)){
       size-=1;
       cell.style.fontSize=`${size}px`;
     }
   });
   return;
 }
 const body=radioDisplay.querySelector(".display-body");
 const primary=radioDisplay.querySelector(".display-primary");
 const secondary=radioDisplay.querySelector(".display-secondary");
 if(!body||!primary)return;

 const activeCanvas=radioDisplay.classList.contains("active-canvas");
 const primaryMax=activeCanvas?Math.min(26,body.clientHeight*.30):52;
 const primaryMin=activeCanvas?13:18;
 const secondaryMax=activeCanvas?Math.min(16,body.clientHeight*.20):(secondary?.classList.contains("multiple")?22:25);
 const secondaryMin=activeCanvas?10:14;

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

function escapeDisplayText(value){
 return String(value).replace(/[&<>"']/g,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]);
}
function displayChannelList(items){
 if(!items.length)return '<span class="radio-display-empty">Geen kanalen</span>';
 return items.map(channel=>{
   const linkedIcon=channel.linked
     ? '<span class="material-symbols-rounded radio-display-link-icon" aria-hidden="true">flowchart</span>'
     : "";
   const label=channel.linked
     ? `[${channel.memberNames.join(", ")}]`
     : channel.name;
   return `<span class="radio-display-channel">${linkedIcon}${escapeDisplayText(label)}</span>`;
 }).join("");
}

function mergeLinkedChannelsForDisplay(items){
 if(!items.length)return [];
 const included=new Set(items.map(channel=>String(channel.id)));
 const visited=new Set();
 const result=[];

 for(const channel of items){
   const channelId=String(channel.id);
   if(visited.has(channelId))continue;

   const directGroupIds=[channelId,...((channel.linkedChannelIds)||[]).map(String)];
   const members=channels
     .filter(candidate=>directGroupIds.includes(String(candidate.id)))
     .sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),"nl",{sensitivity:"base"}));

   const includedMembers=members.filter(member=>included.has(String(member.id)));

   if(members.length>1){
     includedMembers.forEach(member=>visited.add(String(member.id)));
     result.push({
       id:`linked:${members.map(member=>member.id).join(",")}`,
       name:members.map(member=>member.name).join(" + "),
       memberNames:members.map(member=>member.name),
       linked:true,
     });
   }else{
     visited.add(channelId);
     result.push({...channel,linked:false});
   }
 }
 return result;
}
function displayText(value){
 if(Array.isArray(value))return displayChannelList(value);
 return value?`<span class="radio-display-channel">${escapeDisplayText(value)}</span>`:'<span class="radio-display-empty">Geen kanalen</span>';
}
function renderRadioDisplay(mode){
 const listening=radioPowered&&!radioMuted
   ? mergeLinkedChannelsForDisplay(channels.filter(channel=>{
       const tile=document.querySelector(`.channel-tile[data-id="${channel.id}"]`);
       return tile&&audible(tile);
     }))
   : [];
 const transmitting=radioPowered
   ? mergeLinkedChannelsForDisplay(channels.filter(channel=>selected.has(channel.id)))
   : [];
 const lines=[
   {icon:"ear_sound",label:"Luisteren",value:listening},
   {icon:"mic",label:"Zenden",value:transmitting}
 ];
 radioDisplay.className=`display ${mode}`;
 radioDisplay.innerHTML=`<div class="radio-display-table" role="table" aria-label="Luister- en zendkanalen">
   ${lines.map(line=>`<div class="radio-display-icon" role="cell" title="${escapeDisplayText(line.label)}"><span class="material-symbols-rounded" aria-hidden="true">${escapeDisplayText(line.icon)}</span><span class="sr-only">${escapeDisplayText(line.label)}</span></div><div class="radio-display-channels" role="cell">${displayText(line.value)}</div>`).join("")}
 </div>`;
 requestAnimationFrame(fitRadioDisplayText);
}
function renderActiveRadioDisplay(mode,{primary="",primaryIcon="",secondary="",secondaryIcon=""}={}){
 const line=(icon,text)=>`${icon?`<span class="material-symbols-rounded display-line-icon" aria-hidden="true">${escapeDisplayText(icon)}</span>`:""}<span class="display-line-text">${escapeDisplayText(text)}</span>`;
 radioDisplay.className=`display active-canvas ${mode}`;
 radioDisplay.innerHTML=`<div class="display-body" role="status" aria-live="polite">
   <div class="display-primary">${line(primaryIcon,primary)}</div>
   <div class="display-secondary">${line(secondaryIcon,secondary)}</div>
 </div>`;
 requestAnimationFrame(fitRadioDisplayText);
}
function selectDispatchTxChannel(channelId,{persist=true,powerOn=true}={}){
 const id=String(channelId||"");
 const tile=[...document.querySelectorAll(".channel-tile")].find(card=>String(card.dataset.id)===id);
 if(!id||!tile)return false;
 if(!channels.some(channel=>String(channel.id)===id))return false;
 if(powerOn&&!radioPowered)ensureRadioOn();
 if(!radioPowered)return false;
 selected.clear();
 document.querySelectorAll(".channel-tile").forEach(card=>{
   const active=String(card.dataset.id)===id;
   card.classList.toggle("selected",active);
   icon(card);
 });
 selected.add(id);
 selectedTxChannelId=id;
 if(persist)queueDispatchSettingsSave({radio:{selectedTxChannelId:id}});
 setAudioPriority(id);
 void prepareDispatchChannelMicrophone(id).catch(error=>console.error("Dispatchmicrofoon kon niet worden voorbereid",error));
 selectedDisplay();
 refreshRadioDisplay();
 return true;
}
window.DispatchRadio={...(window.DispatchRadio||{}),selectTxChannel:selectDispatchTxChannel};
if(dispatchTxChannelBus){
 dispatchTxChannelBus.addEventListener("message",event=>{
   if(event?.data?.type!=="select-tx-channel")return;
   const id=String(event.data.channelId||"");
   if(id)selectDispatchTxChannel(id,{persist:false,powerOn:true});
 });
}

function selectedDisplay(){
 const arr=channels.filter(c=>selected.has(c.id));
 if(!emergency&&!activeCallRequest&&!isTransmitting()&&!activeReception()){
   renderRadioDisplay("idle");
 }
 document.querySelector("#dispatchPtt").disabled=!radioPowered||!dispatchRadioViewActive||!arr.length;
 document.querySelectorAll("[data-channel-card]").forEach(card=>{
   card.classList.toggle("channel-selected",selected.has(card.dataset.channelCard));
 });
 applyAudio();
}
function isTransmitting(){return [...channelState.values()].some(st=>st.dispatcher)}
function activeReception(){
 const focusId=activePriorityChannel();
 for(const [channelId,st] of channelState){
   if(st.current&&!st.dispatcher&&!st.alarm){
     const tile=document.querySelector(`.channel-tile[data-id="${channelId}"]`);
     if(channelAudioProfile(channelId,tile,focusId)==="muted")continue;
     const channel=channels.find(c=>c.id===channelId);
     return channel?{channel,unit:st.current}:null;
   }
 }
 return null;
}
function activeReceptions(){
 const focusId=activePriorityChannel();
 return [...channelState].flatMap(([channelId,state])=>{
   if(!state.current||state.dispatcher||state.alarm)return [];
   const channel=channels.find(item=>item.id===channelId),tile=document.querySelector(`.channel-tile[data-id="${channelId}"]`);
   const profile=channelAudioProfile(channelId,tile,focusId);
   return channel&&profile!=="muted"?[{channel,unit:state.current,profile}]:[];
 });
}

function startEmergencyBlink(){
 if(emergencyBlinkTimer)return;
 document.body.classList.add("emergency-blink-enabled");
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
 document.body.classList.remove("emergency-blink-enabled");
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
 if(![...channelState.values()].some(channel=>channel.priority99))stopEmergencyBlink();
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
 if(connection?.transmitting)void tx(false);
 dispatchPtt.classList.remove("active");
 pttKeyDown=false;
 emergency=null;
 clearAudioPriority();

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
   renderRadioDisplay("idle");
   radioPanel.classList.add("off");
   return;
 }
 radioPanel.classList.remove("off");
 if(emergency){
   const priority99Active=Number(emergency.priority)===99;
   const emergencyState=channelState.get(emergency.channelId);
   if(!priority99Active&&emergencyState?.dispatcher){
     renderActiveRadioDisplay("transmitting",{
       primary:emergency.channelName,
       secondary:"Dispatch",secondaryIcon:"mic"
     });
     return;
   }
   if(!priority99Active&&emergencyState?.current){
     renderActiveRadioDisplay("receiving",{
       primary:emergency.channelName,
       secondary:emergencyState.current,secondaryIcon:"ear_sound"
     });
     return;
   }
   renderActiveRadioDisplay(emergency.accepted?"emergency acknowledged":"emergency",{
     primary:priority99Active?"NOODOPROEP":emergency.channelName,
     primaryIcon:"e911_emergency",
     secondary:priority99Active?`[${emergency.channelName}] ${emergency.unit}`:emergency.unit,
     secondaryIcon:priority99Active?"ear_sound":"mobile"
   });
   return;
 }
 if(activeCallRequest){
   renderActiveRadioDisplay(isTransmitting()||dispatchTxRequested?"transmitting":"call-request",{
     primary:activeCallRequest.channelName,
     secondary:activeCallRequest.radioName,
     secondaryIcon:"hand_gesture"
   });
   return;
 }
 if(pttDisplayStatus&&![...connections.values()].some(connection=>connection.transmitting)){
   renderActiveRadioDisplay(pttDisplayStatus.mode,{
     primary:channels.filter(channel=>selected.has(channel.id)).map(channel=>channel.name).join(" · ")||"Geen zendkanaal",
     secondary:pttDisplayStatus.text,secondaryIcon:pttDisplayStatus.icon
   });
   return;
 }
 const transmitting=channels.filter(c=>channelState.get(c.id)?.dispatcher);
 if(transmitting.length){
   renderActiveRadioDisplay("transmitting",{
     primary:transmitting.map(channel=>channel.name).join(" · "),
     secondary:"dispatch",secondaryIcon:"mic"
   });
   return;
 }
 const receptions=activeReceptions();
 if(receptions.length===1){
   const reception=receptions[0];
   renderActiveRadioDisplay("receiving",{
     primary:reception.channel.name,
     secondary:reception.unit,secondaryIcon:"ear_sound"
   });
   return;
 }
 if(receptions.length>1){
   const primary=receptions.filter(item=>item.profile==="primary");
   const secondary=receptions.filter(item=>item.profile==="secondary");
   renderActiveRadioDisplay("receiving multi-reception",{
     primary:primary.map(item=>`[${item.channel.name}] ${item.unit}`).join(" · "),
     primaryIcon:primary.length?"ear_sound":"",
     secondary:secondary.map(item=>`[${item.channel.name}] ${item.unit}`).join(" · "),
     secondaryIcon:secondary.length?"hearing_aid":""
   });
   return;
 }
 selectedDisplay();
}
function setEmergency(unitCode,channelId,active,priority=null){
 const channel=channels.find(c=>c.id===channelId);
 if(active&&channel){
   const channelStatus=channelState.get(channelId);
   if(channelStatus){channelStatus.emergencyUnit=unitCode;channelStatus.emergencyPriority=Number(priority)||channelStatus.emergencyPriority||null}
   const incomingPriority=Number(priority)||null;
   if(incomingPriority===99)dismissedEmergencyChannelId=null;
   if(dismissedEmergencyChannelId===channelId&&incomingPriority!==99){tileUpdate(channelId);applyAudio();return}
   clearAudioPriority();
   const isSame=emergency&&emergency.unit===unitCode&&emergency.channelId===channelId;
   const effectivePriority=priority==null&&isSame?emergency.priority:Number(priority)||null;
   emergency={
     unit:unitCode,
     channelId,
     channelName:channel.name,
     priority:effectivePriority,
     accepted:isSame?!!emergency.accepted:false
   };
   if(!emergency.accepted&&emergency.priority===99){
     unmuteMasterForPtt();
     selected.clear();
     document.querySelectorAll(".channel-tile").forEach(tile=>{
       tile.classList.remove("selected");
       icon(tile);
     });
     // Priority 99 onderbreekt iedere lopende dispatch-uitzending. Het
     // noodkanaal wordt alleen zichtbaar gemaakt, nooit automatisch TX.
     if(isTransmitting()&&!dispatchTxRequested)dispatchTxRequested=true;
     if(dispatchTxRequested||isTransmitting())void tx(false);
     document.querySelector(`.channel-tile[data-id="${channelId}"]`)?.scrollIntoView({block:"nearest",behavior:"smooth"});
     setAudioPriority(channelId);
     if(emergency.priority===99)startEmergencyBlink();else stopEmergencyBlink();
   }
   document.querySelector("#dispatchPtt").disabled=!selected.size;
 }else{
   const channelStatus=channelState.get(channelId);
   if(channelStatus){
     channelStatus.emergencyUnit=null;
     channelStatus.emergencyPriority=null;
     channelStatus.priority99=false;
   }
   if(lockedMasterChannelId===channelId)lockedMasterChannelId=null;
   if(emergency&&emergency.channelId===channelId){
   dismissedEmergencyChannelId=null;
   clearEmergency();
   return;
   }
 }
 tileUpdate(channelId);
 overview();
 applyAudio();
 refreshRadioDisplay();
}
function leaveEmergencyView(nextChannelId){
 if(!emergency||emergency.channelId===nextChannelId)return;
 dismissedEmergencyChannelId=emergency.channelId;emergency=null;clearAudioPriority();
 selected.clear();document.querySelectorAll(".channel-tile").forEach(card=>card.classList.remove("selected"));
}
function selectEmergencyChannelExclusively(tile){
 const state=channelState.get(tile.dataset.id),channel=channels.find(item=>item.id===tile.dataset.id);
 dismissedEmergencyChannelId=null;
 emergency={
   unit:state?.emergencyUnit||state?.current||"Radio",
   channelId:tile.dataset.id,
   channelName:channel?.name||tile.dataset.name,
   priority:state?.priority99?99:state?.emergencyPriority||null,
   accepted:false
 };
 selected.clear();
 document.querySelectorAll(".channel-tile").forEach(card=>card.classList.toggle("selected",card===tile));
 selected.add(tile.dataset.id);
 setAudioPriority(tile.dataset.id);
 selectedDisplay();
 document.querySelectorAll(".channel-tile").forEach(icon);
 refreshRadioDisplay();
}
function configureRadioChannelSelector(tile){
 const section=document.querySelector("#radioCardChannelSection"),select=document.querySelector("#radioCardChannel"),feedback=document.querySelector("#radioCardChannelFeedback");
 const isRadio=tile.classList.contains("unit-tile");
 if(section)section.hidden=!isRadio;
 if(feedback){feedback.textContent="";feedback.classList.remove("success")}
 if(!isRadio||!select)return;
 const unit=units.find(item=>String(item.id)===String(tile.dataset.id));
 const assigned=new Set((unit?.assignedChannelIds||[]).map(String));
 const option=channel=>`<option value="${escapeDisplayText(channel.id)}"${String(channel.id)===String(tile.dataset.channel)?" selected":""}>${escapeDisplayText(channel.name)}</option>`;
 const assignedChannels=channels.filter(channel=>assigned.has(String(channel.id)));
 const allTenantChannels=channels;
 select.innerHTML=`<optgroup label="--- Toegewezen pocChannels ---">${assignedChannels.length?assignedChannels.map(option).join(""):'<option disabled>Geen toegewezen pocChannels</option>'}</optgroup><optgroup label="--- Alle pocChannels ---">${allTenantChannels.map(option).join("")}</optgroup>`;
}
function configureRadioStatusSelector(tile){
 const section=document.querySelector("#radioCardStatusSection"),select=document.querySelector("#radioCardStatus");
 if(!section||!select)return;
 const isRadio=tile?.classList.contains("unit-tile");
 section.hidden=!isRadio;
 if(!isRadio){select.innerHTML="";return}

 const currentId=String(tile.dataset.userStatus||"");
 const currentLabel=String(tile.dataset.userStatusLabel||"");
 const options=Array.isArray(dispatchUserStatuses)?dispatchUserStatuses:[];
 const rows=options.map(status=>{
   const id=String(status.pk??status.id??"");
   const slug=String(status.fields?.slug??status.slug??"");
   const displayStatus=String(
     status.fields?.display_status??status.display_status??
     status.fields?.display_label??status.display_label??
     status.fields?.display_code??status.display_code??""
   );
   const suppliedLabel=String(status.fields?.choice_label??status.choice_label??"");
   const text=suppliedLabel||(slug&&displayStatus?`${slug} - ${displayStatus}`:(slug||displayStatus||id));
   return `<option value="${escapeDisplayText(id)}"${id===currentId?" selected":""}>${escapeDisplayText(text)}</option>`;
 }).join("");

 // Als de actuele radio-status niet in het schema zit, toon hem wel als
 // read-only herkenbare huidige keuze. Een nieuwe keuze komt altijd uit het schema.
 const currentMissing=currentId&&!options.some(status=>String(status.pk??status.id??"")===currentId);
 select.innerHTML=(currentMissing
   ? `<option value="${escapeDisplayText(currentId)}" selected disabled>${escapeDisplayText(currentLabel||"Huidige status")} (buiten schema)</option>`
   : "")+rows;
}

document.querySelectorAll(".tile").forEach(tile=>{
 s(tile);icon(tile);
 tile.onclick=e=>{
   if(!radioPowered||e.target.closest("button")||tile.classList.contains("dispatcher-tile"))return;
   if(tile.classList.contains("channel-tile"))leaveEmergencyView(tile.dataset.id);
   if(tile.classList.contains("channel-tile")&&channelState.get(tile.dataset.id)?.alarm){
     selectEmergencyChannelExclusively(tile);return;
   }
   tile.classList.toggle("selected");
   if(tile.classList.contains("channel-tile")){
     if(tile.classList.contains("selected")){
       selected.add(tile.dataset.id);setAudioPriority(tile.dataset.id);
       void prepareDispatchChannelMicrophone(tile.dataset.id).catch(error=>console.error("Dispatchmicrofoon kon niet worden voorbereid",error));
     }else{selected.delete(tile.dataset.id);clearAudioPriorityForDeselectedChannel(tile.dataset.id)}
     selectedDisplay();
   }
   icon(tile);
 };
 const audioButton=tile.querySelector(".audio");
 if(audioButton)audioButton.onclick=e=>{e.stopPropagation();if(!radioPowered)return;cycleChannelAudioMode(tile)};
 const settingsButton=tile.querySelector(".settings");
 if(settingsButton)settingsButton.onclick=e=>{e.stopPropagation();if(!radioPowered)return;currentTile=tile;const st=s(tile);document.querySelector("#modalTitle").textContent=tile.dataset.name;cardBalance.value=Math.round(st.right-st.left);channelHotkey.textContent=hotkeyLabel(st.hotkey);document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("active",b.dataset.mode===st.mode));configureRadioChannelSelector(tile);configureRadioStatusSelector(tile);const emergencySection=document.querySelector("#radioCardEmergencySection"),isEmergencyRadio=tile.classList.contains("unit-tile")&&(tile.dataset.emergency==="true"||tile.classList.contains("alarm")||unitState.get(tile.dataset.name)?.alarm);if(emergencySection)emergencySection.hidden=!isEmergencyRadio;const feedback=document.querySelector("#radioCardEmergencyFeedback");if(feedback){feedback.textContent="";feedback.classList.remove("success")}modal.showModal()};
});
modalClose.onclick=()=>modal.close();
cardBalance.oninput=e=>{
 if(!currentTile)return;
 const balance=Number(e.target.value),state=s(currentTile);
 state.left=balance>0?100-balance:100;
 state.right=balance<0?100+balance:100;
 saveChannel(currentTile);applyAudio();renderAssignedChannels();
};
document.querySelector("#cancelRadioEmergency")?.addEventListener("click",async event=>{
 if(!currentTile?.classList.contains("unit-tile"))return;
 const button=event.currentTarget,feedback=document.querySelector("#radioCardEmergencyFeedback");button.disabled=true;
 if(feedback){feedback.textContent="Noodoproep annuleren…";feedback.classList.remove("success")}
 try{
   const tenant=encodeURIComponent(document.body.dataset.tenantSlug);
   const response=await fetch(`/dispatch/${tenant}/api/radios/${encodeURIComponent(currentTile.dataset.id)}/emergency/cancel/`,{
     method:"POST",credentials:"same-origin",headers:{"X-CSRFToken":decodeURIComponent(cookieValue("csrftoken"))}
   });
   const text=await response.text();let payload={};try{payload=JSON.parse(text)}catch(_){throw new Error(text||`HTTP ${response.status}`)}if(!response.ok||!payload.ok)throw new Error(payload.error||`HTTP ${response.status}`);
   const state=unitState.get(currentTile.dataset.name);if(state)state.alarm=false;
   currentTile.dataset.emergency="false";
   currentTile.classList.remove("alarm");
   if(feedback){feedback.textContent="Noodoproep is geannuleerd";feedback.classList.add("success")}
   document.querySelector("#radioCardEmergencySection").hidden=true;
   overview();refreshRadioDisplay();void refreshCallRequests();window.setTimeout(()=>modal.close(),650);
 }catch(error){console.error("Noodoproep kon niet worden geannuleerd",error);if(feedback)feedback.textContent=error.message||"Noodoproep kon niet worden geannuleerd";playDispatchErrorTone()}
 finally{button.disabled=false}
});
document.querySelector("#saveRadioCardStatus")?.addEventListener("click",async event=>{
 if(!currentTile?.classList.contains("unit-tile"))return;
 const button=event.currentTarget,select=document.querySelector("#radioCardStatus"),feedback=document.querySelector("#radioCardStatusFeedback");
 if(!select?.value)return;
 button.disabled=true;if(feedback){feedback.textContent="Status wijzigen…";feedback.classList.remove("success")}
 try{
   const tenant=encodeURIComponent(document.body.dataset.tenantSlug);
   const response=await fetch(`/dispatch/${tenant}/api/radios/${encodeURIComponent(currentTile.dataset.id)}/status/`,{
     method:"POST",
     credentials:"same-origin",
     headers:{"Content-Type":"application/json","X-CSRFToken":decodeURIComponent(cookieValue("csrftoken"))},
     body:JSON.stringify({status_id:select.value})
   });
   const text=await response.text();let payload={};try{payload=JSON.parse(text)}catch(_){throw new Error(text||`HTTP ${response.status}`)}
   if(!response.ok||!payload.ok)throw new Error(payload.error||`HTTP ${response.status}`);

   currentTile.dataset.userStatus=String(payload.data.status_id||"");
   currentTile.dataset.userStatusLabel=String(payload.data.label||"");
   if(feedback){feedback.textContent=`Status ingesteld: ${payload.data.label||payload.data.display_code||""}`;feedback.classList.add("success")}
   void refreshAddressBookConnectionStatus();
   window.DispatchStates?.refresh?.();
   window.DispatchNetwork?.refresh?.();
   window.setTimeout(()=>{if(feedback)feedback.textContent=""},1600);
 }catch(error){
   console.error("Gebruikersstatus kon niet worden gewijzigd",error);
   if(feedback)feedback.textContent=error.message||"Gebruikersstatus kon niet worden gewijzigd";
   playDispatchErrorTone();
 }finally{button.disabled=false}
});

document.querySelector("#saveRadioCardChannel")?.addEventListener("click",async event=>{
 if(!currentTile?.classList.contains("unit-tile"))return;
 const button=event.currentTarget,select=document.querySelector("#radioCardChannel"),feedback=document.querySelector("#radioCardChannelFeedback");
 button.disabled=true;if(feedback){feedback.textContent="Kanaal wijzigen…";feedback.classList.remove("success")}
 try{
   const tenant=encodeURIComponent(document.body.dataset.tenantSlug);
   const response=await fetch(`/dispatch/${tenant}/api/radios/${encodeURIComponent(currentTile.dataset.id)}/channel/`,{
     method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-CSRFToken":decodeURIComponent(cookieValue("csrftoken"))},body:JSON.stringify({channel_id:select.value})
   });
   const text=await response.text();let payload={};try{payload=JSON.parse(text)}catch(_){throw new Error(text||`HTTP ${response.status}`)}if(!response.ok||!payload.ok)throw new Error(payload.error||`HTTP ${response.status}`);
   const oldChannelId=currentTile.dataset.channel,newChannelId=String(payload.data.channel_id),state=unitState.get(currentTile.dataset.name);
   currentTile.dataset.channel=newChannelId;currentTile.querySelector(".secondary").textContent=payload.data.channel_name;
   if(state)state.channelId=newChannelId;
   if(payload.data.emergency_active){
     const oldState=channelState.get(oldChannelId),newState=channelState.get(newChannelId);
     if(oldState){oldState.emergencyUnits=(oldState.emergencyUnits||[]).filter(name=>name!==currentTile.dataset.name);oldState.alarm=oldState.emergencyUnits.length>0;tileUpdate(oldChannelId)}
     if(newState){
       newState.emergencyUnits=[...new Set([...(newState.emergencyUnits||[]),currentTile.dataset.name])];
       newState.emergencyUnit=currentTile.dataset.name;
       newState.alarm=true;tileUpdate(newChannelId);
     }
     if(emergency?.unit===currentTile.dataset.name){
       emergency.channelId=newChannelId;
       emergency.channelName=payload.data.channel_name;
       if(lockedMasterChannelId===oldChannelId)lockedMasterChannelId=newChannelId;
       if(priorityChannelId===oldChannelId)priorityChannelId=newChannelId;
       selected.clear();selected.add(newChannelId);
       document.querySelectorAll(".channel-tile").forEach(tile=>{
         tile.classList.toggle("selected",tile.dataset.id===newChannelId);
         icon(tile);
       });
     }
   }
   if(activeCallRequest?.radioName===currentTile.dataset.name&&!activeCallRequest.cleared){
     activeCallRequest.channelId=newChannelId;
     activeCallRequest.channelName=payload.data.channel_name;
     selected.clear();selected.add(newChannelId);
     document.querySelectorAll(".channel-tile").forEach(tile=>{
       tile.classList.toggle("selected",tile.dataset.id===newChannelId);
       icon(tile);
     });
     setAudioPriority(newChannelId);
   }
   if(feedback){feedback.textContent=`Kanaal ingesteld op ${payload.data.channel_name}`;feedback.classList.add("success")}
   overview();refreshRadioDisplay();
 }catch(error){console.error("Radiokanaal kon niet worden gewijzigd",error);if(feedback)feedback.textContent=error.message||"Radiokanaal kon niet worden gewijzigd";playDispatchErrorTone()}
 finally{button.disabled=false}
});
document.querySelectorAll("[data-mode]").forEach(b=>b.onclick=()=>{
 if(!currentTile)return;
 s(currentTile).mode=b.dataset.mode;
 saveChannel(currentTile);
 icon(currentTile);
 renderAssignedChannels();
 refreshRadioDisplay();
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
powerButton.onclick=()=>setRadioPower(!radioPowered);
radioSettingsButton.onclick=()=>{if(!radioPowered)return;
 radioVolumeLeft.value=masterLeft;radioVolumeLeftValue.value=masterLeft;
 radioVolumeRight.value=masterRight;radioVolumeRightValue.value=masterRight;
 secondaryVolume.value=secondaryAudioVolume;secondaryVolumeValue.value=secondaryAudioVolume;
 txAcceptTone.checked=txAcceptToneEnabled;
 keyTone.checked=keyToneEnabled;
 const cra=document.querySelector("#callRequestAudioEnabled"),crv=document.querySelector("#callRequestAudioVolume"),crvv=document.querySelector("#callRequestAudioVolumeValue");
 if(cra)cra.checked=callRequestAudioEnabled;if(crv)crv.value=callRequestAudioVolume;if(crvv)crvv.value=callRequestAudioVolume;
 for(let priority=2;priority<=6;priority++){const input=document.querySelector(`#priority${priority}Pings`);if(input)input.value=callRequestPingCounts[priority]}
 muteHotkey.textContent=hotkeyLabel(muteHotkeyCode);
 renderAssignedChannels();radioSettingsModal.showModal();
};
radioSettingsClose.onclick=()=>radioSettingsModal.close();
muteHotkey.onclick=()=>beginHotkeyCapture(muteHotkey);
clearMuteHotkey.onclick=()=>{muteHotkeyCode="";saveRadio();muteHotkey.textContent="Niet toegewezen"};
function setSideVolume(side,value){
 const level=Math.max(0,Math.min(100,Number(value)));
 if(side==="left")masterLeft=level;else masterRight=level;
 masterVolume=Math.round((masterLeft+masterRight)/2);
 frontLeftVolume.value=masterLeft;frontRightVolume.value=masterRight;
 radioVolumeLeft.value=masterLeft;radioVolumeLeftValue.value=masterLeft;
 radioVolumeRight.value=masterRight;radioVolumeRightValue.value=masterRight;
 radioMuted=false;saveRadio();applyAudio();updateSpeakerMuteState();
}
radioVolumeLeft.oninput=e=>setSideVolume("left",e.target.value);
radioVolumeRight.oninput=e=>setSideVolume("right",e.target.value);
secondaryVolume.oninput=e=>{
 secondaryAudioVolume=Math.max(0,Math.min(100,Number(e.target.value)));
 secondaryVolumeValue.value=secondaryAudioVolume;
 saveRadio();applyAudio();
};
txAcceptTone.onchange=e=>{txAcceptToneEnabled=!!e.target.checked;saveRadio()};
keyTone.onchange=e=>{keyToneEnabled=!!e.target.checked;saveRadio()};
document.querySelector("#callRequestAudioEnabled")?.addEventListener("change",e=>{callRequestAudioEnabled=!!e.target.checked;if(!callRequestAudioEnabled)interruptCallRequestAlarm();saveCallRequestAudio()});
document.querySelector("#callRequestAudioVolume")?.addEventListener("input",e=>{callRequestAudioVolume=Math.max(0,Math.min(100,Number(e.target.value)));const output=document.querySelector("#callRequestAudioVolumeValue");if(output)output.value=callRequestAudioVolume;saveCallRequestAudio()});
for(let priority=2;priority<=6;priority++)document.querySelector(`#priority${priority}Pings`)?.addEventListener("change",e=>{callRequestPingCounts[priority]=Math.max(0,Math.min(12,Number(e.target.value)||0));e.target.value=callRequestPingCounts[priority];saveCallRequestAudio()});
[frontLeftVolume,frontRightVolume].forEach((slider,index)=>slider.oninput=e=>{
 setSideVolume(index===0?"left":"right",e.target.value);
});

const dispatchRadioButtons=Array.isArray(dispatchButtonDefinitions.radio)
 ? dispatchButtonDefinitions.radio.filter(button=>button&&button.enabled!==false)
 : [];
const dispatchSystemSidebarButtons=[
 {id:"system-radio",type:"sidebar",label:"Radio",enabled:true,system:true,action:{type:"show_radio"}},
 {id:"system-map",type:"sidebar",label:"Kaart",enabled:true,system:true,action:{type:"show_map"}},
 {id:"system-network",type:"sidebar",label:"Netwerk",enabled:true,system:true,action:{type:"show_network"}},
 {id:"system-states",type:"sidebar",label:"Status",enabled:true,system:true,action:{type:"show_states"}},
];
const dispatchSidebarButtons=[
 ...dispatchSystemSidebarButtons,
 ...(Array.isArray(dispatchButtonDefinitions.sidebar)
   ? dispatchButtonDefinitions.sidebar.filter(button=>button&&button.enabled!==false)
   : []),
];
let sidebarButtonPage=0;

function dispatchButtonForSlot(slot){
 return dispatchRadioButtons.find(button=>String(button.slot||"").toUpperCase()===String(slot).toUpperCase())||null;
}

async function executeConfiguredDispatchAction(button){
 const action=button?.action||{},type=typeof action==="string"?action:String(action.type||"");
 if(!type)return;
 if(type==="show_radio"){
   window.DispatchMap?.showInlineRadio?.();
   return;
 }
 if(type==="show_map"){
   window.DispatchMap?.showInlineMap?.();
   return;
 }
 if(type==="show_network"){
   const host=document.querySelector(".address-book");
   const mapView=document.getElementById("addressBookMapView");
   const networkView=document.getElementById("addressBookNetworkView");
   const statesView=document.getElementById("addressBookStatesView");
   if(!host||!networkView)return;
   if(mapView)mapView.hidden=true;
   if(statesView)statesView.hidden=true;
   host.classList.remove("map-mode","states-mode");
   host.classList.add("network-mode");
   networkView.hidden=false;
   window.dispatchEvent(new CustomEvent("dispatch-address-view",{detail:{view:"network"}}));
   window.DispatchNetwork?.refresh?.();
   return;
 }
 if(type==="show_states"){
   const host=document.querySelector(".address-book");
   const mapView=document.getElementById("addressBookMapView");
   const networkView=document.getElementById("addressBookNetworkView");
   const statesView=document.getElementById("addressBookStatesView");
   if(!host||!statesView)return;
   if(mapView)mapView.hidden=true;
   if(networkView)networkView.hidden=true;
   host.classList.remove("map-mode","network-mode");
   host.classList.add("states-mode");
   statesView.hidden=false;
   window.dispatchEvent(new CustomEvent("dispatch-address-view",{detail:{view:"states"}}));
   window.DispatchStates?.refresh?.();
   return;
 }
 if(type==="highlight_radio_on_map"){
   const target=action.radio_id??action.radio_slug??action.radio_name??action.radio??action.value;
   if(target===undefined||target===null||String(target).trim()==="")throw new Error("Geen radio ingesteld voor kaartmarkering");
   window.DispatchMap?.showInlineMap?.();
   const ok=await window.DispatchMap?.highlightRadio?.(String(target));
   if(!ok)throw new Error("Radio heeft geen recente kaartlocatie");
   return;
 }
 const tenant=encodeURIComponent(document.body.dataset.tenantSlug),headers={"X-CSRFToken":decodeURIComponent(cookieValue("csrftoken"))};
 if(type==="end_emergency"){
   const tile=emergency
     ? [...document.querySelectorAll('.unit-tile[data-actor-kind="radio"]')].find(item=>item.dataset.name===emergency.unit)
     : document.querySelector('.unit-tile[data-actor-kind="radio"][data-emergency="true"]');
   if(!tile)throw new Error("Geen actieve noodoproep gevonden");
   const response=await fetch(`/dispatch/${tenant}/api/radios/${encodeURIComponent(tile.dataset.id)}/emergency/cancel/`,{method:"POST",credentials:"same-origin",headers});
   const payload=await response.json().catch(()=>({}));if(!response.ok||payload.ok===false)throw new Error(payload.error||payload.detail||`HTTP ${response.status}`);
   if(emergency)clearEmergency();
   tile.dataset.emergency="false";tile.classList.remove("alarm");
   void refreshCallRequests();
   return;
 }
 if(type==="revoke_current_tx"){
   const channelId=activePriorityChannel()||[...selected].slice(-1)[0];
   const channel=channels.find(item=>String(item.id)===String(channelId));
   if(!channel)throw new Error("Geen actief radiokanaal geselecteerd");
   const response=await fetch(`/dispatch/${tenant}/api/channels/${encodeURIComponent(channel.slug)}/ptt/revoke/`,{method:"POST",credentials:"same-origin",headers});
   const payload=await response.json().catch(()=>({}));if(!response.ok||payload.ok===false)throw new Error(payload.error||payload.detail||`HTTP ${response.status}`);
   setPttDisplayStatus("idle",payload.revoked?"TX-toestemming ingetrokken":"Geen actieve TX op kanaal","block");
   return;
 }
 logDispatchEvent("error","dispatch_button_unknown_action",{buttonId:button.id,action:type});
}

function handleConfiguredButton(button,pressed=true){
 if(!button)return;
 logDispatchEvent("info","dispatch_button",{buttonId:button.id,buttonType:button.type,label:button.label,pressed:!!pressed,action:button.action||{}});
 // Beheeracties worden éénmaal op pointerdown uitgevoerd; pointerup is alleen
 // visuele release van de configureerbare knop.
 if(!pressed)return;
 void executeConfiguredDispatchAction(button).catch(error=>{
   logDispatchEvent("error","dispatch_button_action_failed",{buttonId:button.id,error:error?.message||String(error)});
   playDispatchErrorTone();setPttDisplayStatus("idle",error?.message||"Knopactie mislukt","block");
 });
}

function bindConfiguredButton(element,button){
 if(!element||!button)return;
 element.dataset.dispatchButtonId=button.id;
 element.classList.add("dispatch-config-button");
 element.disabled=button.system?false:!radioPowered;
 element.addEventListener("pointerdown",event=>{
   event.preventDefault();
   if(element.disabled)return;
   element.classList.add("active");
   if(keyToneEnabled)void dispatchTone(720,55,0,.14);
   handleConfiguredButton(button,true);
 });
 ["pointerup","pointerleave","pointercancel"].forEach(name=>{
   element.addEventListener(name,event=>{
     event.preventDefault();
     element.classList.remove("active");
     handleConfiguredButton(button,false);
   });
 });
}

function renderRadioButtons(){
 document.querySelectorAll("[data-radio-slot]").forEach(element=>{
   const slot=element.dataset.radioSlot;
   const button=dispatchButtonForSlot(slot);
   const span=element.querySelector("span");
   if(button){
     if(span)span.textContent=button.label||slot;
     element.hidden=false;
     element.disabled=!radioPowered;
     if(!element.dataset.dispatchButtonBound){
       bindConfiguredButton(element,button);
       element.dataset.dispatchButtonBound="1";
     }
   }else{
     if(span)span.textContent=slot;
     element.hidden=true;
   }
 });
}

function sidebarColumnCount(){
 const grid=document.querySelector("#sidebarButtons");
 if(!grid)return 2;
 const columns=getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
 return Math.max(2,columns||2);
}

function sidebarButtonCapacity(){
 const rail=document.querySelector("#sidebarButtonRail");
 if(!rail)return 4;
 const grid=document.querySelector("#sidebarButtons");
 const columns=sidebarColumnCount();
 const style=grid?getComputedStyle(grid):null;
 const gap=parseFloat(style?.rowGap||style?.gap||"10")||10;
 const buttonHeight=64;
 const usable=Math.max(0,rail.clientHeight-24);
 const rows=Math.max(1,Math.floor((usable+gap)/(buttonHeight+gap)));
 return Math.max(columns,rows*columns);
}

function renderSidebarButtons(){
 const grid=document.querySelector("#sidebarButtons");
 if(!grid)return;
 const systemButtons=dispatchSidebarButtons.filter(button=>button.system);
 const configuredButtons=dispatchSidebarButtons.filter(button=>!button.system);
 const capacity=Math.max(systemButtons.length+1,sidebarButtonCapacity());
 const availableWithoutPaging=Math.max(0,capacity-systemButtons.length);
 const paged=configuredButtons.length>availableWithoutPaging;
 const pageSize=Math.max(1,paged?capacity-systemButtons.length-2:availableWithoutPaging);
 const pageCount=Math.max(1,Math.ceil(configuredButtons.length/pageSize));
 sidebarButtonPage=Math.min(sidebarButtonPage,pageCount-1);
 const start=sidebarButtonPage*pageSize;
 const visibleConfigured=paged?configuredButtons.slice(start,start+pageSize):configuredButtons.slice(0,pageSize);

 grid.innerHTML="";
 const appendButton=button=>{
   const element=document.createElement("button");
   element.type="button";
   element.className=`function-key sidebar-config-button${button.system?" sidebar-system-button":""}`;
   element.innerHTML=`<span>${escapeDisplayText(button.label||button.id)}</span>`;
   if(button.system){
     const actionType=String(button.action?.type||"");
     const networkVisible=!document.getElementById("addressBookNetworkView")?.hidden;
     const statesVisible=!document.getElementById("addressBookStatesView")?.hidden;
     const current=statesVisible?"states":(networkVisible?"network":(window.DispatchMap?.currentView?.()||"radio"));
     if(
       (actionType==="show_radio"&&current==="radio")||
       (actionType==="show_map"&&current==="map")||
       (actionType==="show_network"&&current==="network")||
       (actionType==="show_states"&&current==="states")
     )element.classList.add("selected-view");
   }
   bindConfiguredButton(element,button);
   grid.appendChild(element);
 };
 systemButtons.forEach(appendButton);

 if(paged){
   const previous=document.createElement("button");
   previous.type="button";
   previous.className="function-key sidebar-nav-button";
   previous.innerHTML='<span class="material-symbols-rounded" aria-hidden="true">arrow_back</span>';
   previous.title="Vorige buttons";
   previous.disabled=sidebarButtonPage<=0;
   previous.onclick=()=>{if(sidebarButtonPage>0){sidebarButtonPage--;renderSidebarButtons()}};

   const next=document.createElement("button");
   next.type="button";
   next.className="function-key sidebar-nav-button";
   next.innerHTML='<span class="material-symbols-rounded" aria-hidden="true">arrow_forward</span>';
   next.title="Volgende buttons";
   next.disabled=sidebarButtonPage>=pageCount-1;
   next.onclick=()=>{if(sidebarButtonPage<pageCount-1){sidebarButtonPage++;renderSidebarButtons()}};

   grid.append(previous,next);
 }
 visibleConfigured.forEach(appendButton);

 grid.dataset.page=String(sidebarButtonPage+1);
 grid.dataset.pages=String(pageCount);
}

function renderDispatchButtons(){
 renderRadioButtons();
 renderSidebarButtons();
}


function addressBookGroupLabel(value){
 const text=String(value||"").trim();
 return text||"Not assigned";
}
function addressBookGroupKey(value){
 const label=addressBookGroupLabel(value);
 return label==="Not assigned"?"__not_assigned__":label.toLocaleLowerCase("nl-NL");
}

let activeAddressBookGroupFilter=null;

function channelTileById(channelId){
 const id=String(channelId??"");
 if(!id)return null;
 return document.querySelector(`.channel-tile[data-id="${CSS.escape(id)}"]`);
}
function channelGroupKeyForId(channelId){
 const tile=channelTileById(channelId);
 return tile?addressBookGroupKey(s(tile).group):null;
}
function channelGroupLabelForId(channelId){
 const tile=channelTileById(channelId);
 return tile?addressBookGroupLabel(s(tile).group):"";
}

function addressBookCardMetrics(){
 const host=document.querySelector("#channelGroups");
 if(!host)return {width:160,gap:6,columns:6,available:0};
 const available=Math.max(0,host.clientWidth);
 const root=document.querySelector(".address-book")||host;
 const style=getComputedStyle(root);
 const gap=Math.max(0,parseFloat(style.getPropertyValue("--phonebook-card-gap"))||6);
 const sizingWidth=240;
 const columns=Math.max(6,Math.floor((available+gap)/(sizingWidth+gap))||6);
 const width=Math.max(1,(available-gap*(columns-1))/columns);
 root.style.setProperty("--phonebook-card-width",`${width}px`);
 host.style.setProperty("--phonebook-card-width",`${width}px`);
 return {width,gap,columns,available};
}

function layoutAddressBookGroups(){
 const host=document.querySelector("#channelGroups");
 if(!host)return;
 const available=Math.max(0,host.clientWidth);
 if(!available)return;

 const metrics=addressBookCardMetrics();
 const cardWidth=metrics.width;
 const cardGap=metrics.gap;
 const hostStyle=getComputedStyle(host);
 const groupGap=Math.max(0,parseFloat(hostStyle.columnGap||hostStyle.gap)||14);

 const maxColumns=Math.max(6,metrics.columns);
 const sections=[...host.querySelectorAll(".channel-group-section")];

 // De groepen zijn door renderAddressBookGroups() al alfabetisch gesorteerd.
 // De layout vult iedere regel zo ver mogelijk. Als een groep niet meer volledig
 // past, mag hij op dezelfde regel beginnen wanneer er nog minimaal 4 cards
 // naast elkaar passen. De vervolgregels starten exact onder card 1 van die groep.
 let usedWidth=0;

 for(const section of sections){
   section.classList.remove("group-wrap");
   section.style.removeProperty("--group-columns");
   section.style.removeProperty("--group-width");

   const count=section.querySelectorAll(".channel-tile").length;
   if(!count)continue;

   const naturalWidth=(count*cardWidth)+Math.max(0,count-1)*cardGap;
   const prefix=usedWidth>0?groupGap:0;
   const remaining=Math.max(0,available-usedWidth-prefix);
   const remainingColumns=Math.max(0,Math.floor((remaining+cardGap)/(cardWidth+cardGap)));

   let columns=count;
   let sectionWidth=naturalWidth;
   let wraps=false;

   if(naturalWidth<=remaining+0.5){
     // De hele groep past nog op de huidige regel.
     columns=count;
     sectionWidth=naturalWidth;
   }else if(usedWidth>0 && remainingColumns>=4){
     // Gebruik de resterende ruimte, maar alleen wanneer er minimaal vier
     // cards van deze groep naast elkaar kunnen staan.
     columns=Math.min(count,remainingColumns);
     sectionWidth=(columns*cardWidth)+Math.max(0,columns-1)*cardGap;
     wraps=count>columns;

     // Vul de resterende regel zodat de volgende groep op een nieuwe buitenste
     // flex-regel begint. De interne vervolgregel van deze groep blijft onder
     // de eerste card van de groep uitgelijnd.
     sectionWidth=Math.max(sectionWidth,remaining);
   }else{
     // Minder dan vier plaatsen over: begin deze groep op een nieuwe regel.
     columns=Math.min(count,maxColumns);
     sectionWidth=(columns*cardWidth)+Math.max(0,columns-1)*cardGap;
     wraps=count>columns;
     usedWidth=0;
   }

   if(wraps)section.classList.add("group-wrap");
   section.style.setProperty("--group-columns",String(Math.max(1,columns)));
   section.style.setProperty("--group-width",`${Math.min(sectionWidth,available)}px`);

   // Een intern gewrapte groep reserveert de rest van de buitenste regel.
   if(wraps){
     usedWidth=0;
   }else{
     usedWidth=(usedWidth>0?usedWidth+groupGap:0)+Math.min(sectionWidth,available);
     if(usedWidth>=available-1)usedWidth=0;
   }
 }
}
function renderAddressBookGroups(){
 const host=document.querySelector("#channelGroups");
 const nav=document.querySelector("#addressBookGroupNav");
 const unitsSection=document.querySelector("#unitsSection");
 if(!host||!nav||!unitsSection)return;

 const tiles=[...document.querySelectorAll(".channel-tile")].sort((a,b)=>
   String(a.dataset.name||"").localeCompare(String(b.dataset.name||""),"nl",{sensitivity:"base"})
 );
 const grouped=new Map();
 for(const tile of tiles){
   const state=s(tile),label=addressBookGroupLabel(state.group),key=addressBookGroupKey(state.group);
   if(!grouped.has(key))grouped.set(key,{label,tiles:[]});
   grouped.get(key).tiles.push(tile);
 }

 const named=[...grouped.entries()]
   .filter(([key])=>key!=="__not_assigned__")
   .sort((a,b)=>a[1].label.localeCompare(b[1].label,"nl",{sensitivity:"base"}));
 const notAssigned=grouped.get("__not_assigned__");
 const ordered=[...named];
 if(notAssigned)ordered.push(["__not_assigned__",notAssigned]);

 host.innerHTML="";
 for(const [key,group] of ordered){
   const section=document.createElement("section");
   section.className="channel-group-section";
   section.dataset.addressGroup=key;
   section.id=`address-group-${encodeURIComponent(key).replaceAll("%","-")}`;
   const title=document.createElement("div");
   title.className="section-title";
   title.textContent=group.label;
   const grid=document.createElement("div");
   grid.className="tile-grid";
   group.tiles.forEach(tile=>grid.appendChild(tile));
   section.append(title,grid);
   host.appendChild(section);
 }

 const radioGrid=unitsSection.querySelector(".tile-grid");
 if(radioGrid){
   [...radioGrid.querySelectorAll(".unit-tile")]
     .sort((a,b)=>String(a.dataset.name||"").localeCompare(String(b.dataset.name||""),"nl",{sensitivity:"base"}))
     .forEach(tile=>radioGrid.appendChild(tile));
 }

 layoutAddressBookGroups();

 nav.innerHTML="";
 const navItems=ordered.map(([key,group])=>({key,label:group.label,section:host.querySelector(`[data-address-group="${CSS.escape(key)}"]`)}));
 navItems.push({key:"radios",label:"Radio's",section:unitsSection});
 for(const item of navItems){
   const button=document.createElement("button");
   button.type="button";
   button.className="address-book-group-button";
   button.textContent=item.label;
   button.dataset.addressGroupButton=item.key;
   button.onclick=()=>{
     // De groepsknoppen zijn filters; de layout/positie van het paneel blijft ongewijzigd.
     activeAddressBookGroupFilter=activeAddressBookGroupFilter===item.key?null:item.key;
     document.querySelectorAll(".address-book-group-button").forEach(btn=>{
       btn.classList.toggle("active",btn.dataset.addressGroupButton===activeAddressBookGroupFilter);
     });
     applyAddressBookSearch();
   };
   nav.appendChild(button);
 }
 document.querySelectorAll(".address-book-group-button").forEach(btn=>{
   btn.classList.toggle("active",btn.dataset.addressGroupButton===activeAddressBookGroupFilter);
 });
 applyAddressBookSearch();
}
function applyAddressBookSearch(){
 const q=String(search?.value||"").trim().toLocaleLowerCase("nl-NL");
 const channelTiles=[...document.querySelectorAll(".channel-tile")];
 const unitTiles=[...document.querySelectorAll("#unitsSection .tile")];

 // Zoeken is altijd globaal en negeert een eventueel actief groepsfilter.
 // Een groepsnaam matcht het kanaal zelf én alle radio's die op een kanaal
 // binnen die groep staan.
 if(q){
   for(const tile of channelTiles){
     const channelName=String(tile.dataset.name||"").toLocaleLowerCase("nl-NL");
     const baseSearch=String(tile.dataset.search||"").toLocaleLowerCase("nl-NL");
     const groupLabel=addressBookGroupLabel(s(tile).group).toLocaleLowerCase("nl-NL");
     tile.hidden=!(channelName.includes(q)||baseSearch.includes(q)||groupLabel.includes(q));
   }

   for(const tile of unitTiles){
     const baseSearch=String(tile.dataset.search||"").toLocaleLowerCase("nl-NL");
     const channelId=tile.dataset.channel||"";
     const channelTile=channelTileById(channelId);
     const channelName=String(channelTile?.dataset.name||"").toLocaleLowerCase("nl-NL");
     const groupLabel=channelGroupLabelForId(channelId).toLocaleLowerCase("nl-NL");
     tile.hidden=!(baseSearch.includes(q)||channelName.includes(q)||groupLabel.includes(q));
   }
 }else if(activeAddressBookGroupFilter){
   // Filterknop: toon de kanalen uit de gekozen groep en daarnaast alle
   // radio's die op die kanalen staan. De speciale knop Radio's toont de
   // bestaande radio/dispatcher-sectie zonder de kanaalsecties.
   if(activeAddressBookGroupFilter==="radios"){
     channelTiles.forEach(tile=>{tile.hidden=true});
     unitTiles.forEach(tile=>{tile.hidden=false});
   }else{
     const visibleChannelIds=new Set();
     for(const tile of channelTiles){
       const visible=addressBookGroupKey(s(tile).group)===activeAddressBookGroupFilter;
       tile.hidden=!visible;
       if(visible)visibleChannelIds.add(String(tile.dataset.id||""));
     }
     for(const tile of unitTiles){
       const isRadio=tile.dataset.actorKind==="radio"||tile.classList.contains("unit-tile");
       const channelId=String(tile.dataset.channel||"");
       tile.hidden=!(isRadio&&visibleChannelIds.has(channelId));
     }
   }
 }else{
   channelTiles.forEach(tile=>{tile.hidden=false});
   unitTiles.forEach(tile=>{tile.hidden=false});
 }

 document.querySelectorAll(".channel-group-section").forEach(section=>{
   const tiles=[...section.querySelectorAll(".tile")];
   section.hidden=tiles.length>0&&!tiles.some(tile=>!tile.hidden);
 });
 requestAnimationFrame(layoutAddressBookGroups);
}
function renderAssignedChannels(){
 const sortedChannels=[...channels].sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),"nl",{sensitivity:"base"}));
 assignedChannelsBody.innerHTML=sortedChannels.map(ch=>{
   const tile=document.querySelector(`.channel-tile[data-id="${ch.id}"]`),st=s(tile);
   const balance=Math.round(st.right-st.left);
   return `<tr data-settings-channel="${ch.id}">
     <td>${escapeDisplayText(ch.name)}</td>
     <td><input class="channel-group-input" data-channel-group type="text" value="${escapeDisplayText(st.group||"")}" placeholder="Not assigned" autocomplete="off"></td>
     <td><select data-table-mode><option value="primary"${st.mode==="primary"?" selected":""}>Primair</option><option value="secondary"${st.mode==="secondary"?" selected":""}>Secundair</option><option value="selected-only"${st.mode==="selected-only"?" selected":""}>Alleen bij geselecteerd</option></select></td>
     <td><div class="balance-control"><span>L</span><input data-table-balance class="balance-slider" type="range" min="-100" max="100" value="${balance}"><span>R</span></div></td>
     <td><button class="hotkey-input table-hotkey" data-channel-hotkey type="button">${hotkeyLabel(st.hotkey)}</button></td>
   </tr>`;
 }).join("");
 assignedChannelsBody.querySelectorAll("tr").forEach(row=>{
   const tile=document.querySelector(`.channel-tile[data-id="${row.dataset.settingsChannel}"]`);
   row.querySelector("[data-channel-group]").onchange=e=>{
     s(tile).group=String(e.target.value||"").trim();
     e.target.value=s(tile).group;
     saveChannel(tile);
     renderAddressBookGroups();
   };
   row.querySelector("[data-table-mode]").onchange=e=>{s(tile).mode=e.target.value;saveChannel(tile);icon(tile);refreshRadioDisplay()};
   row.querySelector("[data-table-balance]").oninput=e=>{
     const balance=Number(e.target.value);
     s(tile).left=balance>0?100-balance:100;
     s(tile).right=balance<0?100+balance:100;
     saveChannel(tile);applyAudio();
   };
   row.querySelector("[data-channel-hotkey]").onclick=e=>beginHotkeyCapture(e.currentTarget);
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
   if(capturingHotkey===muteHotkey){muteHotkeyCode=code;saveRadio();muteHotkey.textContent=hotkeyLabel(code)}
   if(capturingHotkey.matches("[data-channel-hotkey]")){
     const tile=document.querySelector(`.channel-tile[data-id="${capturingHotkey.closest("tr").dataset.settingsChannel}"]`);
     s(tile).hotkey=code;saveChannel(tile);capturingHotkey.textContent=hotkeyLabel(code);
   }
   endHotkeyCapture();return;
 }
 if(!radioPowered||e.repeat||["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName))return;
 if(muteHotkeyCode&&e.code===muteHotkeyCode){e.preventDefault();document.querySelector("#speakerMuteButton").click();return}
 if(pttHotkeyCode&&e.code===pttHotkeyCode){e.preventDefault();pttKeyDown=true;void prepareSelectedDispatchMicrophones();tx(true);return}
 if(toggleChannelByHotkey(e.code))e.preventDefault();
},true);
window.addEventListener("keyup",e=>{if(radioPowered&&pttHotkeyCode&&e.code===pttHotkeyCode&&pttKeyDown){e.preventDefault();pttKeyDown=false;tx(false)}},true);


function updateSpeakerMuteState(){
 const button=document.querySelector("#speakerMuteButton");
 if(!button)return;
 button.classList.toggle("muted",radioMuted);
 button.setAttribute("aria-pressed",String(radioMuted));
 button.querySelector(".material-symbols-rounded").textContent=radioMuted?"volume_up":"volume_off";
 if(frontLeftVolume)frontLeftVolume.value=radioMuted?0:masterLeft;
 if(frontRightVolume)frontRightVolume.value=radioMuted?0:masterRight;
}
function unmuteMasterForPtt(){
 if(!radioMuted)return false;
 radioMuted=false;
 masterVolume=Math.max(1,previousVolume||masterVolume||100);
 if(masterLeft===0&&masterRight===0)masterLeft=masterRight=masterVolume;
 saveRadio();updateSpeakerMuteState();applyAudio();refreshRadioDisplay();
 return true;
}
document.querySelector("#speakerMuteButton").onclick=()=>{
 if(radioMuted){
   radioMuted=false;
   masterVolume=Math.max(1,previousVolume||100);
   if(masterLeft===0&&masterRight===0)masterLeft=masterRight=masterVolume;
 }else{
   previousVolume=masterVolume>0?masterVolume:(previousVolume||100);
   radioMuted=true;
 }
 saveRadio();
 updateSpeakerMuteState();
 applyAudio();
 refreshRadioDisplay();
};

search.oninput=()=>{if(!radioPowered)return;applyAddressBookSearch()};
function cookieValue(name){
 return document.cookie.split(";").map(value=>value.trim()).find(value=>value.startsWith(`${name}=`))?.slice(name.length+1)||"";
}
function formatRequestTime(timestamp){
 return new Date(Number(timestamp)).toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit"});
}
function renderCallRequests(items){
 const list=document.querySelector("#contactRequestsList");if(!list)return;
 if(!items.length){list.innerHTML='<p class="empty">Geen contact requests</p>';return}
 list.innerHTML=items.map(item=>`<article class="contact-request-item${activeCallRequest?.id===item.id||emergency?.requestId===item.id?" selected":""}" data-call-request="${item.id}" data-priority="${escapeDisplayText(item.priority)}" data-channel-id="${escapeDisplayText(item.channel_id)}" data-channel-name="${escapeDisplayText(item.channel_name)}" data-radio-name="${escapeDisplayText(item.radio_name)}">
   <div class="contact-request-line"><strong>${escapeDisplayText(item.radio_name)}</strong><span class="contact-request-right">${Number(item.priority)===1?'<button class="claim-emergency-request" type="button">Claim</button>':''}<span class="contact-request-priority priority-${escapeDisplayText(item.priority)}">${escapeDisplayText(item.priority)}</span><span class="contact-request-separator">|</span>${escapeDisplayText(item.status)}</span></div>
   <div class="contact-request-line"><span>${escapeDisplayText(item.channel_name)}</span><time class="contact-request-right">${formatRequestTime(item.activated_at_ms)}</time></div>
  </article>`).join("");
}
async function refreshCallRequests(){
 if(!radioPowered)return;
 try{
   const tenant=encodeURIComponent(document.body.dataset.tenantSlug),response=await fetch(`/dispatch/${tenant}/api/call-requests/`,{credentials:"same-origin"});
   const payload=await response.json();if(!response.ok||!payload.ok)throw new Error(payload.error||`HTTP ${response.status}`);
   syncCallRequestAudio(payload.data||[]);
   if(activeCallRequest&&!activeCallRequest.cleared){
     const current=payload.data.find(item=>Number(item.id)===Number(activeCallRequest.id));
     if(current&&String(current.channel_id)!==String(activeCallRequest.channelId)){
       activeCallRequest.channelId=String(current.channel_id);
       activeCallRequest.channelName=current.channel_name;
       selected.clear();selected.add(activeCallRequest.channelId);
       document.querySelectorAll(".channel-tile").forEach(tile=>{
         tile.classList.toggle("selected",tile.dataset.id===activeCallRequest.channelId);
         icon(tile);
       });
       setAudioPriority(activeCallRequest.channelId);
       selectedDisplay();refreshRadioDisplay();
     }
   }
   renderCallRequests(payload.data);
 }catch(error){console.error("Contact requests konden niet worden geladen",error)}
}
async function selectCallRequest(card){
 const channelId=card.dataset.channelId,channel=channels.find(item=>item.id===channelId);if(!channel)return;
 selected.clear();selected.add(channelId);
 document.querySelectorAll(".channel-tile").forEach(tile=>{tile.classList.toggle("selected",tile.dataset.id===channelId);icon(tile)});
 void prepareDispatchChannelMicrophone(channelId).catch(error=>console.error("Dispatchmicrofoon kon niet worden voorbereid",error));
 if(Number(card.dataset.priority)===1){
   const tenant=encodeURIComponent(document.body.dataset.tenantSlug);
   const response=await fetch(`/dispatch/${tenant}/api/call-requests/${card.dataset.callRequest}/accept/`,{
     method:"POST",credentials:"same-origin",headers:{"X-CSRFToken":decodeURIComponent(cookieValue("csrftoken"))}
   });
   const payload=await response.json();if(!response.ok||!payload.ok)throw new Error(payload.error||`HTTP ${response.status}`);
   markCallRequestClaimed(card.dataset.callRequest);
   activeCallRequest=null;
   dismissedEmergencyChannelId=null;
   const state=channelState.get(channelId);
   if(state){
     state.alarm=true;
     state.emergencyUnit=card.dataset.radioName;
     state.emergencyPriority=state.priority99?99:null;
   }
   emergency={
     requestId:Number(card.dataset.callRequest),
     unit:card.dataset.radioName,
     channelId,
     channelName:card.dataset.channelName,
     priority:state?.priority99?99:null,
     accepted:true
   };
   lockedMasterChannelId=channelId;
   clearAudioPriority();
   card.remove();
   void refreshCallRequests();
   refreshRadioDisplay();
   return;
 }
 activeCallRequest={id:Number(card.dataset.callRequest),channelId,channelName:card.dataset.channelName,radioName:card.dataset.radioName,cleared:false};
 setAudioPriority(channelId);
 document.querySelectorAll(".contact-request-item").forEach(item=>item.classList.toggle("selected",item===card));
 selectedDisplay();refreshRadioDisplay();
 // Dubbelklik claimt/laadt een normale contact request alleen lokaal:
 // kanaal selecteren + blauwe gesprekscontext tonen. De request blijft
 // server-side in de lijst/status staan totdat de dispatcher daadwerkelijk
 // PTT indrukt en zendtoestemming is verkregen.
 refreshRadioDisplay();
}
document.querySelector("#contactRequestsList")?.addEventListener("dblclick",event=>{
 if(!radioPowered)return;
 const card=event.target.closest("[data-call-request]");if(card)void selectCallRequest(card).catch(error=>{console.error(error);playDispatchErrorTone()});
});
document.querySelector("#contactRequestsList")?.addEventListener("click",event=>{
 const claim=event.target.closest(".claim-emergency-request");if(!claim||!radioPowered)return;
 event.preventDefault();event.stopPropagation();
 const card=claim.closest("[data-call-request]");claim.disabled=true;claim.textContent="Claimen…";
 void selectCallRequest(card).catch(error=>{
   console.error("Noodoproep kon niet worden geclaimd",error);
   if(claim.isConnected){claim.disabled=false;claim.textContent="Claim"}
   playDispatchErrorTone();
 });
});
async function clearSelectedCallRequest(){
 if(!activeCallRequest||activeCallRequest.cleared)return;
 const current=activeCallRequest;
 const tenant=encodeURIComponent(document.body.dataset.tenantSlug);
 const response=await fetch(`/dispatch/${tenant}/api/call-requests/${current.id}/clear/`,{
   method:"POST",credentials:"same-origin",headers:{"X-CSRFToken":decodeURIComponent(cookieValue("csrftoken"))}
 });
 const payload=await response.json();if(!response.ok||!payload.ok)throw new Error(payload.error||`HTTP ${response.status}`);
 if(activeCallRequest?.id===current.id)activeCallRequest.cleared=true;
 void refreshCallRequests();
}
function send(c,d){if(c.socket.readyState===WebSocket.OPEN)c.socket.send(JSON.stringify(d))}
async function waitForDispatchSocket(connection,timeoutMs=2000){
 const started=Date.now();
 while(Date.now()-started<timeoutMs){
   if(connection.socket?.readyState===WebSocket.OPEN)return true;
   await new Promise(resolve=>setTimeout(resolve,40));
 }
 return false;
}
function dispatchApiHeaders(){
 return {"Content-Type":"application/json",Authorization:`Bearer ${dispatchControlCredentials.access_token}`,"X-POC-Session-ID":dispatchControlCredentials.session_id};
}
async function dispatchParrotFloor(c,action){
 const tenant=encodeURIComponent(document.body.dataset.tenantSlug),slug=encodeURIComponent(c.channelSlug);
 const headers={"Content-Type":"application/json","X-CSRFToken":decodeURIComponent(cookieValue("csrftoken"))};
 const response=await fetch(`/dispatch/${tenant}/api/channels/${slug}/parrot/${action}/`,{method:"POST",credentials:"same-origin",headers,body:"{}"});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(typeof payload.detail==="string"?payload.detail:`Papegaai ${action} mislukt (${response.status})`);
 return payload;
}
async function dispatchChannelPtt(c,action,body){
 const tenant=encodeURIComponent(document.body.dataset.tenantSlug),slug=encodeURIComponent(c.channelSlug);
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),2000);
 let response;
 logDispatchEvent("info","ptt_request",{channel:c.channelSlug,action});
 const headers={"Content-Type":"application/json","X-CSRFToken":decodeURIComponent(cookieValue("csrftoken"))};
 try{response=await fetch(`/dispatch/${tenant}/api/channels/${slug}/ptt/${action}/`,{method:"POST",credentials:"same-origin",headers,body:JSON.stringify(body),signal:controller.signal})}
 catch(error){logDispatchEvent("error","ptt_network_error",{channel:c.channelSlug,action,error:error.message});if(error.name==="AbortError")throw new Error("Verbinding niet binnen 2 seconden beschikbaar");throw error}
 finally{clearTimeout(timeout)}
 const payload=await response.json().catch(()=>({}));
 logDispatchEvent(response.ok?"info":"error","ptt_response",{channel:c.channelSlug,action,status:response.status,payload});
 if(!response.ok)throw new Error(typeof payload.detail==="string"?payload.detail:(payload.error||`PTT ${action} mislukt (${response.status})`));
 return payload;
}
function dispatchHeartbeatTelemetry(){
 const channelsTelemetry={};
 for(const c of connections.values()) channelsTelemetry[c.channelSlug]=c.livekit?c.livekit.takeTelemetry():{transport:"webrtc",provider:"livekit",connection_state:"disconnected",samples:0};
 return {transport:"webrtc",provider:"livekit",radio_powered:!!radioPowered,channels:channelsTelemetry};
}
async function heartbeatDispatchSession(){
 if(!dispatchControlCredentials)return false;
 const telemetry=dispatchHeartbeatTelemetry();
 const tenant=encodeURIComponent(document.body.dataset.tenantSlug);
 try{
   const [controlResponse,dispatchResponse]=await Promise.all([
     fetch("/poc/api/v1/session/heartbeat/",{
       method:"POST",headers:dispatchApiHeaders(),
       body:JSON.stringify({heartbeat_id:`dispatch-${clientId}-${Date.now()}`,sent_at_ms:Date.now(),telemetry})
     }),
     fetch(`/dispatch/${tenant}/api/heartbeat/`,{
       method:"POST",credentials:"same-origin",
       headers:{"Content-Type":"application/json","X-CSRFToken":decodeURIComponent(cookieValue("csrftoken"))},
       body:JSON.stringify({telemetry})
     }),
   ]);
   return controlResponse.ok&&dispatchResponse.ok;
 }catch(_){return false}
}
async function ensureDispatchAudioContext(){
 if(!dispatchAudioContext)dispatchAudioContext=new (window.AudioContext||window.webkitAudioContext)({latencyHint:"interactive"});
 if(dispatchAudioContext.state==="suspended")await dispatchAudioContext.resume();
 return dispatchAudioContext;
}
function downsampleDispatchPcm() { throw new Error("Raw PCM is verwijderd; WebRTC/Opus is de enige media-engine."); }
async function ensureDispatchMicrophone() { throw new Error("Raw PCM is verwijderd; WebRTC/Opus is de enige media-engine."); }
function resetChannelPlayback() { throw new Error("Raw PCM is verwijderd; WebRTC/Opus is de enige media-engine."); }
async function playChannelPcm() { throw new Error("Raw PCM is verwijderd; WebRTC/Opus is de enige media-engine."); }
async function refreshDispatchLinkTopology(){
 const tenant=encodeURIComponent(document.body.dataset.tenantSlug||"");
 const response=await fetch(`/dispatch/${tenant}/api/network/`,{credentials:"same-origin",cache:"no-store"});
 const payload=await response.json();
 if(!response.ok||!payload.ok)throw new Error(payload.error||`HTTP ${response.status}`);
 const serverChannels=Array.isArray(payload.data?.channels)?payload.data.channels:[];
 const byId=new Map(serverChannels.map(channel=>[String(channel.id),channel]));
 for(const channel of channels){
   const server=byId.get(String(channel.id));
   channel.linkedChannelIds=Array.isArray(server?.links)
     ? server.links.map(link=>String(link.id))
     : [];
 }
 refreshRadioDisplay();
 renderAssignedChannels();
 return payload.data||{};
}

async function reconnectAffectedDispatchChannels(channelIds){
 const ids=[...new Set((channelIds||[]).map(String))];
 if(!ids.length)return;
 const affected=channels.filter(channel=>ids.includes(String(channel.id)));

 for(const channel of affected){
   const c=connections.get(channel.id) || connections.get(String(channel.id));
   if(!c)continue;
   c.closed=true;
   clearTimeout(c.reconnectTimer);
   if(c.pingTimer)clearInterval(c.pingTimer);
   try{c.socket?.close(1000,"channel link changed")}catch(_){}
   if(c.livekit){
     try{await c.livekit.close()}catch(_){}
     c.livekit=null;
   }
   for(const source of c.webrtcSources||[]){try{source.disconnect()}catch(_){}}
   c.webrtcSources?.clear?.();
   for(const element of c.webrtcElements||[]){try{element.remove()}catch(_){}}
   c.webrtcElements?.clear?.();
   try{c.gain?.disconnect()}catch(_){}
   connections.delete(channel.id);
   connections.delete(String(channel.id));
 }

 await Promise.all(affected.map(connectChannel));
 applyAudio();
 updateDispatchConnectionState();
}

async function applyChannelLinksChanged(){
 const affected=[...pendingChannelLinkReconnectIds];
 pendingChannelLinkReconnectIds.clear();

 try{
   await refreshDispatchLinkTopology();
 }catch(error){
   logDispatchEvent("error","channel_links_topology_refresh_failed",{error:error?.message||String(error)});
 }

 try{
   await reconnectAffectedDispatchChannels(affected);
   await refreshChannelPresence().catch(()=>{});
   window.DispatchNetwork?.refresh?.();
 }catch(error){
   logDispatchEvent("error","channel_links_targeted_reconnect_failed",{error:error?.message||String(error)});
 }
}

function handleChannelControl(c,message){
 if(message.type==="channel_links_changed") {
   const ids=Array.isArray(message.channel_ids)&&message.channel_ids.length
     ? message.channel_ids
     : [c.channelId];
   for(const id of ids)pendingChannelLinkReconnectIds.add(String(id));
   clearTimeout(channelLinksReconnectTimer);
   channelLinksReconnectTimer=window.setTimeout(()=>{
     channelLinksReconnectTimer=null;
     void applyChannelLinksChanged();
   },220);
   return;
 }
 const state=channelState.get(c.channelId);if(!state)return;
 const markEmergencyRadio=(name,active)=>{
   const tile=[...document.querySelectorAll(".unit-tile")].find(item=>item.dataset.name===name||item.dataset.search?.includes(String(name||"").toLowerCase()));
   if(tile)tile.classList.toggle("alarm",!!active);
   const unit=unitState.get(name);if(unit)unit.alarm=!!active;
 };
 if(message.type==="floor_available"&&Number(message.session_id||0)===Number(dispatchControlCredentials?.session_id||0)){
   c.floorWakeResolver?.();
   return;
 }
 if(message.type==="control_ready"&&message.emergency_active){
   state.alarm=true;
   state.priority99=Number(message.effective_priority)===99;
   state.emergencyUnits=Array.isArray(message.emergency_users)?message.emergency_users.map(user=>user.name||user.slug).filter(Boolean):[];
   const first=Array.isArray(message.emergency_users)?message.emergency_users[0]:null;
   const name=message.active_speaker_name||first?.name||message.active_speaker_slug||first?.slug||"Radio";
   markEmergencyRadio(name,true);
   setEmergency(name,c.channelId,true,message.effective_priority);
   if(message.emergency_accepted===true){
     if(emergency?.channelId===c.channelId){emergency.accepted=true;emergency.priority=null}
     state.priority99=false;clearAudioPriority();stopEmergencyBlink();
   }
   tileUpdate(c.channelId);return;
 }
 if(message.type==="control_ready"){
   // De backend registreert de gewenste presence al tijdens de WebSocket-handshake.
   // Stuur hem na control_ready nogmaals vanuit de actuele UI-state zodat een
   // reconnect nooit met een verouderd primary/secondary/muted profiel blijft staan.
   c.presenceProfile=null;
   applyAudio();
   const speakerName=message.active_speaker_name||message.active_speaker_slug||null;
   const speakerSlug=message.active_speaker_slug||null;
   if(speakerName&&speakerSlug!==dispatchControlCredentials?.user_slug){
     state.current=speakerName;
     state.currentSlug=speakerSlug;
     const sourceChannelId=inferSpeakerSourceChannel(speakerSlug,speakerName);
     state.linkedVia=!!sourceChannelId&&String(sourceChannelId)!==String(c.channelId);
     interruptCallRequestAlarm(c.channelId);
     state.last=speakerName;
     state.lastAt=Date.now();
     noteChannelActivity(c.channelId);
   }else if(!speakerName&&!state.dispatcher){
     state.current=null;
     state.currentSlug=null;
   }
   tileUpdate(c.channelId);
   return;
 }
 if(message.type==="floor_granted"&&Number(message.effective_priority)===99&&Number(message.session_id||0)!==Number(dispatchControlCredentials?.session_id||0)){
   state.alarm=true;state.priority99=true;interruptCallRequestAlarm(c.channelId);
   const name=message.speaker_name||message.speaker_slug||"Radio";markEmergencyRadio(name,true);
   setEmergency(name,c.channelId,true,99);
   tileUpdate(c.channelId);return;
 }
 if(message.type==="floor_granted"&&Number(message.session_id||0)!==Number(dispatchControlCredentials?.session_id||0)){
   const speakerName=message.speaker_name||message.speaker_slug||"Radio";
   const speakerSlug=message.speaker_slug||null;
   state.current=speakerName;
   state.currentSlug=speakerSlug;
   const sourceChannelId=message.source_channel_id!=null?String(message.source_channel_id):inferSpeakerSourceChannel(speakerSlug,speakerName);
   state.linkedVia=!!sourceChannelId&&sourceChannelId!==String(c.channelId);
   interruptCallRequestAlarm(c.channelId);
   state.last=speakerName;
   state.lastAt=Date.now();
   noteChannelActivity(c.channelId);
   tileUpdate(c.channelId);
   return;
 }
 if(message.type==="floor_released"&&state.priority99){
   state.priority99=false;
   if(emergency?.channelId===c.channelId)emergency.priority=null;
   if(![...channelState.values()].some(channel=>channel.priority99))stopEmergencyBlink();
   refreshRadioDisplay();
 }
 if(message.type==="error"&&c.transmitting){
   c.transmitting=false;state.dispatcher=false;tileUpdate(c.channelId);
   dispatchPtt.classList.toggle("active",[...connections.values()].some(connection=>connection.transmitting));
   setPttDisplayStatus("idle",message.message||"PTT gestopt","block");return;
 }
 if(message.type==="floor_revoked"&&Number(message.session_id||0)===Number(dispatchControlCredentials?.session_id||0)){
   c.transmitting=false;c.optimisticTransmitting=false;c.floorToken="";state.dispatcher=false;tileUpdate(c.channelId);
   const priorityPreemption=message.reason==="priority_91_99_preemption"||message.reason==="higher_priority_hold_preemption";
   if(priorityPreemption&&dispatchTxRequested){
     // PTT is fysiek nog vast: alle lokale audio direct stoppen, overige
     // floors loslaten en dezelfde PTT-hold opnieuw in de wachtrij plaatsen.
     const heldTokens=[...connections].map(([id,connection])=>({id,connection,token:connection.floorToken||""}));
     stopLocalDispatchTransmitImmediately();
     for(const item of heldTokens)item.connection.floorToken="";
     void Promise.all(heldTokens.map(({id,connection,token})=>dispatchChannelPtt(connection,"release",{client_request_id:`dispatch-requeue-release-${clientId}-${Date.now()}-${id}`,floor_token:token}).catch(()=>{}))).finally(()=>{
       if(!dispatchTxRequested)return;
       dispatchTxRequested=false;
       void tx(true);
     });
     return;
   }
   // Niet-priority revoke is bewust definitief voor deze PTT-hold.
   playDispatchErrorTone();
   setPttDisplayStatus("idle","Zendtoestemming ingetrokken","block");
   void tx(false);
   return;
 }
 if(message.type==="floor_revoked"&&state.current){
   if(!message.session_id||message.speaker_slug===state.currentSlug||message.new_speaker_slug){
     stopUnit(c.channelId,state.current);
   }
   return;
 }
 if(message.type==="floor_released"&&state.current){
   if(!message.speaker_slug||message.speaker_slug===state.currentSlug||message.speaker_name===state.current)stopUnit(c.channelId,state.current);
   return;
 }
 if(message.type==="channel_emergency"){
   state.alarm=message.active===true;
   state.emergencyUnits=Array.isArray(message.users)?message.users.map(user=>user.name||user.slug).filter(Boolean):[];
   const first=Array.isArray(message.users)?message.users[0]:null;
   markEmergencyRadio(first?.name||first?.slug,state.alarm);
   setEmergency(first?.name||first?.slug||"Radio",c.channelId,state.alarm,message.effective_priority);tileUpdate(c.channelId);
   return;
 }
 if(message.type==="emergency_accepted"){
   if(emergency?.channelId===c.channelId){emergency.accepted=true;emergency.priority=null}
   state.priority99=false;
   if(lockedMasterChannelId!==c.channelId)clearAudioPriority();
   stopEmergencyBlink();tileUpdate(c.channelId);refreshRadioDisplay();
 }
}

async function prepareDispatchChannelMicrophone(channelId,{retry=true}={}){
 const c=connections.get(String(channelId));
 if(!c)return false;
 if(c.micReady)return true;
 if(c.micReadyPromise)return c.micReadyPromise;

 c.micReadyPromise=(async()=>{
   let lastError=null;
   const attempts=retry?40:1;
   for(let attempt=0;attempt<attempts;attempt++){
     try{
       if(!c.livekit||c.livekit.connectionState!=="connected"){
         throw new Error("WebRTC room is nog niet verbonden.");
       }
       // ensurePublisher maakt de browsermicrofoontrack éénmalig aan,
       // publiceert hem muted en houdt hem klaar voor de volgende PTT.
       await c.livekit.ensurePublisher();
       c.micReady=true;
       logDispatchEvent("info","dispatch_microphone_ready",{channelId:c.channelId,channel:c.channelSlug});
       return true;
     }catch(error){
       lastError=error;
       // Een selectie kan net vóór de LiveKit-room CONNECTED is gebeuren.
       // Alleen dat timingvenster retryen; permissiefouten blijven zichtbaar.
       if(!retry||/permission|denied|notallowed|notfound|device/i.test(String(error?.name||"")+" "+String(error?.message||"")))break;
       await new Promise(resolve=>setTimeout(resolve,150));
     }
   }
   c.micReady=false;
   logDispatchEvent("error","dispatch_microphone_prepare_failed",{
     channelId:c.channelId,channel:c.channelSlug,
     error:lastError?.message||String(lastError||"Microfoon niet beschikbaar"),
     name:lastError?.name||null
   });
   throw lastError||new Error("Microfoon niet beschikbaar");
 })().finally(()=>{c.micReadyPromise=null});
 return c.micReadyPromise;
}

function prepareSelectedDispatchMicrophones(){
 const promises=[...selected].map(id=>
   prepareDispatchChannelMicrophone(id).catch(error=>{
     console.error(`Microfoon voor kanaal ${id} kon niet worden voorbereid`,error);
     return false;
   })
 );
 return Promise.all(promises);
}

async function connectChannel(ch){
 if(!dispatchControlCredentials||connections.has(ch.id))return;
 const context=await ensureDispatchAudioContext(),gain=context.createGain();gain.gain.value=0;gain.connect(context.destination);
   const c={channelId:ch.id,channelSlug:ch.slug,socket:null,gain,sources:new Set(),playbackTime:context.currentTime,reconnectTimer:null,pingTimer:null,pendingPingId:null,pendingPingStartedAt:0,lastRoundtripMs:null,lastPongAt:null,closed:false,transmitting:false,optimisticTransmitting:false,floorToken:"",presenceProfile:null,livekit:null,micReady:false,micReadyPromise:null,floorWakeResolver:null,webrtcElements:new Set(),webrtcSources:new Set()};
 connections.set(ch.id,c);applyAudio();updateDispatchMediaStartupStatus();
 const open=()=>{
   if(c.closed)return;
   const protocol=location.protocol==="https:"?"wss":"ws",params=new URLSearchParams(dispatchControlCredentials);
   const tile=document.querySelector(`.channel-tile[data-id="${ch.id}"]`);
   const initialPresenceProfile=channelAudioProfile(ch.id,tile,activePriorityChannel());
   params.set("presence_profile",initialPresenceProfile);
   const socketUrl=`${protocol}://${location.host}/poc/ws/v1/control/${encodeURIComponent(document.body.dataset.tenantSlug)}/${encodeURIComponent(ch.slug)}/?${params}`;
   logDispatchEvent("info","socket_connect",{channelId:ch.id,channel:ch.slug});
   const socket=new WebSocket(socketUrl);
   c.socket=socket;
   const stopPing=()=>{if(c.pingTimer)clearInterval(c.pingTimer);c.pingTimer=null;c.pendingPingId=null;c.pendingPingStartedAt=0};
   const sendPing=()=>{
     if(c.socket!==socket||socket.readyState!==WebSocket.OPEN)return;
     const pingId=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
     c.pendingPingId=pingId;c.pendingPingStartedAt=performance.now();
     try{socket.send(JSON.stringify({type:"ping",ping_id:pingId}))}catch(_){}
   };
   const startPing=()=>{stopPing();sendPing();c.pingTimer=setInterval(sendPing,WS_PING_INTERVAL_MS)};
   socket.onopen=()=>{
     logDispatchEvent("info","socket_open",{channelId:ch.id,channel:ch.slug});c.presenceProfile=null;startPing();applyAudio();updateDispatchConnectionState();updateDispatchMediaStartupStatus();
     {
       if(!window.PocLiveKitMedia){logDispatchEvent("error","webrtc_library_missing",{channel:ch.slug});return}
       c.livekit=new window.PocLiveKitMedia({
         tokenUrl:dispatchControlCredentials.webrtc_token_url,
         bitrateKbps:dispatchControlCredentials.opus_bitrate_kbps||20,
         prepublishMicrophone:true,
         linkedRoomReceivePrimaryOnly:true,
         onState:state=>logDispatchEvent("info","webrtc_state",{channel:ch.slug,state}),
         onParrotFloorRequest:async()=>{
           for(let attempt=0;attempt<12;attempt+=1){
             try{const result=await dispatchParrotFloor(c,"start");if(result?.started)return true}catch(_){}
             await new Promise(resolve=>setTimeout(resolve,100));
           }
           return false;
         },
         onParrotFloorRelease:async()=>{await dispatchParrotFloor(c,"stop").catch(()=>{})},
         onRemoteElement:(element)=>{
           try{
             document.body.appendChild(element);c.webrtcElements.add(element);
             const source=context.createMediaElementSource(element);source.connect(c.gain);c.webrtcSources.add(source);
           }catch(error){logDispatchEvent("error","webrtc_audio_route_error",{channel:ch.slug,error:error.message})}
         },
       });
       void c.livekit.connect(ch.slug).then(async()=>{
         await c.livekit.setReceiveEnabled(c.presenceProfile!=="muted");
         // connect() levert pas op nadat de microfoon muted gepubliceerd en
         // speaker/playback gestart is. Daarmee is PTT #1 geen cold-start meer.
         c.micReady=true;
         logDispatchEvent("info","dispatch_media_ready",{channelId:c.channelId,channel:c.channelSlug});
         updateDispatchMediaStartupStatus();
       }).catch(error=>{
         c.micReady=false;
         updateDispatchMediaStartupStatus();
         logDispatchEvent("error","webrtc_connect_error",{channel:ch.slug,error:error.message});
       });
     }
   };
   socket.onerror=()=>logDispatchEvent("error","socket_error",{channelId:ch.id,channel:ch.slug,readyState:socket.readyState});
   socket.onmessage=event=>{
     if(typeof event.data!=="string"){try{socket.close(4400,"Binary media is niet toegestaan")}catch(_){}return}
     try{
       const message=JSON.parse(event.data);
       if(message.type==="pong"){
         if(message.ping_id&&message.ping_id===c.pendingPingId&&c.pendingPingStartedAt){
           c.lastRoundtripMs=Math.max(0,Math.round(performance.now()-c.pendingPingStartedAt));
           c.lastPongAt=new Date().toISOString();c.pendingPingId=null;c.pendingPingStartedAt=0;
           logDispatchEvent("info","socket_pong",{channelId:ch.id,channel:ch.slug,roundtripMs:c.lastRoundtripMs,lastPongAt:c.lastPongAt,serverTimestampMs:message.timestamp_ms??null});
         }
         return;
       }
       handleChannelControl(c,message);
     }catch(error){logDispatchEvent("error","control_message_error",{channel:ch.slug,error:error.message,data:String(event.data).slice(0,500)});console.warn("Ongeldig audiocontrolbericht",error)}
   };
   socket.onclose=event=>{stopPing();c.micReady=false;updateDispatchMediaStartupStatus();logDispatchEvent(event.code===1000?"info":"error","socket_close",{channelId:ch.id,channel:ch.slug,code:event.code,reason:event.reason,clean:event.wasClean,lastRoundtripMs:c.lastRoundtripMs,lastPongAt:c.lastPongAt});if(c.livekit){void c.livekit.close().catch(()=>{});c.livekit=null}for(const source of c.webrtcSources){try{source.disconnect()}catch(_){}}c.webrtcSources.clear();for(const element of c.webrtcElements){try{element.remove()}catch(_){}}c.webrtcElements.clear();updateDispatchConnectionState();if(!c.closed)c.reconnectTimer=setTimeout(open,5000)};
 };
 open();
}
async function initDispatchMedia(){
 dispatchInitialConnectPending=true;
 setPttDisplayStatus("idle","Activeren","power_settings_new");
 try{
   const tenant=document.body.dataset.tenantSlug,response=await fetch(`/dispatch/${encodeURIComponent(tenant)}/api/media-bootstrap/`,{credentials:"same-origin"});
   const payload=await response.json();if(!response.ok||!payload.ok)throw new Error(payload.error||`HTTP ${response.status}`);
   txPermissionMode=payload.data.tx_permission_mode==="proactive"?"proactive":"conservative";
   dispatchControlCredentials={transport:"webrtc",session_id:String(payload.data.audio.session_id),access_token:payload.data.audio.access_token,dispatch_token:payload.data.audio.dispatch_token,user_slug:payload.data.identity?.user_slug||"",dispatch_session_id:payload.data.audio.dispatch_session_id,webrtc_token_url:payload.data.audio.webrtc_token_url,opus_bitrate_kbps:Number(payload.data.audio.opus_bitrate_kbps||20),opus_dtx:payload.data.audio.opus_dtx!==false,opus_red:payload.data.audio.opus_red===true};
   logDispatchEvent("info","tx_permission_mode",{mode:txPermissionMode});
   logDispatchEvent("info","audio_bootstrap",{configuredChannels:channels.map(channel=>({id:channel.id,slug:channel.slug,name:channel.name})),serverChannels:payload.data.channels||[]});
   refreshChannelPresence();
   await Promise.all(channels.map(connectChannel));
   // De WebSockets openen asynchroon. Tijdens deze normale opstartfase tonen we nog geen reconnect-banner.
   window.setTimeout(()=>{
     dispatchInitialConnectPending=false;
     updateDispatchConnectionState();
   },5000);
   return true;
 }catch(error){
   dispatchInitialConnectPending=false;
   logDispatchEvent("error","audio_bootstrap_error",{error:error.message});
   console.error("Dispatch RX-audio kon niet starten",error);
   updateDispatchConnectionState();scheduleDispatchReconnect();return false
 }
}
async function reconnectDispatch(){
 if(dispatchReconnectRunning)return;
 clearDispatchReconnectTimer();
 dispatchReconnectRunning=true;
 // Alleen een reeds zichtbare banner krijgt de reconnect-status; een normale
 // achtergrondreconnect blijft stil gedurende de 15-seconden grace period.
 const reconnectBanner=document.querySelector("#connectionLostBanner");
 if(reconnectBanner&&!reconnectBanner.hidden)setConnectionLost(true,true);
 for(const connection of connections.values()){
   connection.closed=true;clearTimeout(connection.reconnectTimer);
   try{connection.socket?.close()}catch(_){}
   if(connection.livekit){try{await connection.livekit.close()}catch(_){}}
   resetChannelPlayback(connection);
 }
 connections.clear();dispatchControlCredentials=null;
 try{
   const started=await initDispatchMedia();
   if(!started)setConnectionLost(true,false);
 }finally{
   dispatchReconnectRunning=false;
   window.setTimeout(()=>{updateDispatchConnectionState();const connected=[...connections.values()].some(connection=>connection.socket?.readyState===WebSocket.OPEN);if(!connected)scheduleDispatchReconnect()},300);
 }
}
async function refreshChannelPresence(){
 try{
   const tenant=encodeURIComponent(document.body.dataset.tenantSlug),response=await fetch(`/dispatch/${tenant}/api/channel-presence/`,{credentials:"same-origin"});
   const payload=await response.json();if(!response.ok||!payload.ok)throw new Error(payload.error||`HTTP ${response.status}`);
   for(const channel of channels){
     const counts=payload.data[channel.id]||{radios:0,dispatchers:0};
     const tile=document.querySelector(`.channel-tile[data-id="${channel.id}"]`);
     if(tile?.querySelector("[data-radio-presence]"))tile.querySelector("[data-radio-presence]").textContent=String(counts.radios||0);
     if(tile?.querySelector("[data-dispatch-presence]"))tile.querySelector("[data-dispatch-presence]").textContent=String(counts.dispatchers||0);
     const linkCount=Math.max(0,Number(counts.link_count)||0);
     let linkBadge=tile?.querySelector("[data-link-count]");
     if(tile&&!linkBadge&&linkCount>0){
       const presence=tile.querySelector(".channel-presence");
       if(presence){
         linkBadge=document.createElement("span");
         linkBadge.className="channel-link-count";
         linkBadge.dataset.linkCount="";
         linkBadge.title="Gekoppelde kanalen";
         linkBadge.innerHTML='<span class="material-symbols-rounded" aria-hidden="true">flowchart</span><span data-link-count-value></span>';
         presence.appendChild(linkBadge);
       }
     }
     if(linkBadge){
       const value=linkBadge.querySelector("[data-link-count-value]");
       if(value)value.textContent=String(linkCount);
       linkBadge.hidden=linkCount===0;
     }
   }
 }catch(error){console.error("Audio-aanwezigheid kon niet worden geladen",error)}
}
function setActorConnectionStatus(tile,status){
 const normalized=["connected","degraded","offline"].includes(status)?status:"offline";
 const icon=tile?.querySelector("[data-connection-icon]");
 if(!icon)return;
 icon.classList.remove("connection-connected","connection-degraded","connection-offline");
 icon.classList.add(`connection-${normalized}`);
 const labels={connected:"Connected",degraded:"Verbindingsprobleem",offline:"Offline"};
 icon.title=labels[normalized];
 icon.setAttribute("aria-label",labels[normalized]);
 tile.dataset.connectionStatus=normalized;
}
async function refreshAddressBookConnectionStatus(){
 try{
   const tenant=encodeURIComponent(document.body.dataset.tenantSlug);
   const response=await fetch(`/dispatch/${tenant}/api/addressbook-status/`,{credentials:"same-origin",cache:"no-store"});
   const payload=await response.json();
   if(!response.ok||!payload.ok)throw new Error(payload.detail||`HTTP ${response.status}`);
   document.querySelectorAll('.actor-tile[data-actor-kind="radio"]').forEach(tile=>setActorConnectionStatus(tile,payload.radios?.[String(tile.dataset.id)]));
   document.querySelectorAll('.actor-tile[data-actor-kind="dispatch"]').forEach(tile=>setActorConnectionStatus(tile,payload.dispatchers?.[String(tile.dataset.id)]));
 }catch(error){
   logDispatchEvent("error","addressbook_status_error",{error:error?.message||String(error)});
 }
}

function linkedIdsForChannel(channelId){
 const channel=channels.find(item=>String(item.id)===String(channelId));
 return [String(channelId),...((channel?.linkedChannelIds)||[]).map(String)];
}
function inferSpeakerSourceChannel(speakerSlug,speakerName){
 const match=[...unitState.entries()].find(([code,state])=>
   (speakerSlug&&state.slug===speakerSlug)||(speakerName&&code===speakerName)
 );
 return match?.[1]?.channelId?String(match[1].channelId):null;
}
function syncDispatchLinkedVisuals(){
 for(const state of channelState.values()){
   state.dispatcher=false;
   state.linkedVia=false;
 }
 const directIds=[...channelState.entries()].filter(([,state])=>state.dispatcherDirect).map(([id])=>String(id));
 for(const sourceId of directIds){
   for(const memberId of linkedIdsForChannel(sourceId)){
     const state=channelState.get(memberId);
     if(!state)continue;
     state.dispatcher=true;
     if(memberId!==sourceId&&!directIds.includes(memberId))state.linkedVia=true;
   }
 }
}
function speakerMarkup(state,text){
 if(!text)return "";
 const icon=state?.linkedVia?'<span class="material-symbols-rounded linked-tx-icon" aria-hidden="true">flowchart</span>':"";
 return `${icon}${escapeDisplayText(text)}`;
}
function tileUpdate(id){
 const st=channelState.get(id),t=document.querySelector(`.channel-tile[data-id="${id}"]`);
 if(!t)return;
 const accepted=!!(emergency&&emergency.accepted&&emergency.channelId===id);
 t.classList.toggle("receiving",!!st.current&&!st.dispatcher&&!st.alarm);
 t.classList.toggle("transmitting",st.dispatcher&&!st.alarm);
 t.classList.toggle("alarm",st.alarm);
 t.classList.toggle("alarm-accepted",accepted);
 const emergencyNames=Array.isArray(st.emergencyUnits)?st.emergencyUnits.filter(Boolean):[];
 const secondaryText=st.alarm&&emergencyNames.length
   ? `Nood: ${emergencyNames.join(" · ")}`
   : st.dispatcher?"Dispatch":(st.current||((Date.now()-st.lastAt)<60000?st.last:"")||"");
 t.querySelector(".secondary").innerHTML=speakerMarkup(st,secondaryText);
 refreshRadioDisplay();
}
function stopUnit(id,code){const st=channelState.get(id);st.current=null;st.currentSlug=null;st.linkedVia=false;st.last=code;st.lastAt=Date.now();clearTimeout(st.timer);st.timer=setTimeout(()=>{if(Date.now()-st.lastAt>=60000){st.last=null;tileUpdate(id)}},60050);tileUpdate(id)}
function overview(){
 document.querySelectorAll(".unit-tile").forEach(tile=>{
   const state=unitState.get(tile.dataset.name);
   tile.classList.toggle("alarm",!!state?.alarm);
   tile.classList.toggle("transmitting",!!state?.speaking&&!state?.alarm);
 });
 for(const ch of channels){
   const list=document.querySelector(`[data-list="${ch.id}"]`);
   if(!list)continue;
   const rows=[...unitState].filter(([,v])=>v.channelId===ch.id&&v.online);
   list.innerHTML=rows.length?rows.map(([code,v])=>{
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
   }).join(""):'<div class="empty">Geen actieve radio\'s</div>';
 }
 void refreshChannelPresence();
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

function monitorConnect(){const protocol=location.protocol==="https:"?"wss":"ws";monitor=new WebSocket(`${protocol}://${location.host}/ws/monitor/`);monitor.onmessage=e=>{const m=JSON.parse(e.data),u=unitState.get(m.unit),c=channelState.get(m.channel_id);if(m.type==="unit_online"&&u){u.online=true;u.channelId=m.channel_id}if(m.type==="unit_offline"&&u){u.online=false;u.speaking=false}if(m.type==="unit_latency"&&u)u.latency=m.latency_ms;if(m.type==="unit_alarm"&&u&&c){u.alarm=m.active;c.alarm=[...unitState.values()].some(x=>x.channelId===m.channel_id&&x.alarm);tileUpdate(m.channel_id);setEmergency(m.unit,m.channel_id,m.active,m.priority)}if(m.type==="unit_speaking"&&u&&c){u.speaking=m.speaking;if(m.speaking){c.current=m.unit;c.last=m.unit;c.lastAt=Date.now();noteChannelActivity(m.channel_id)}else if(c.current===m.unit)stopUnit(m.channel_id,m.unit);tileUpdate(m.channel_id)}overview()};monitor.onclose=()=>setTimeout(monitorConnect,2000)}
function setPttDisplayStatus(mode,text,icon){pttDisplayStatus={mode,text,icon};refreshRadioDisplay()}
function updateDispatchMediaStartupStatus(){
 const all=[...connections.values()];
 const ready=all.length>0&&all.every(c=>c.livekit&&c.livekit.connectionState==="connected"&&c.micReady===true);
 if(!ready){
   setPttDisplayStatus("idle","Activeren","power_settings_new");
   return false;
 }
 if(pttDisplayStatus?.text==="Activeren")setPttDisplayStatus("idle","","radio");
 return true;
}
function stopLocalDispatchTransmitImmediately(){
 stopDispatchBusyBuzz();
 for(const [id,c] of connections){
   if(!c.transmitting&&!c.optimisticTransmitting)continue;
   try{if(c.livekit)void c.livekit.setTransmit(false).catch(()=>{})}catch(_){}
   c.transmitting=false;c.optimisticTransmitting=false;
   const st=channelState.get(id);if(st)st.dispatcherDirect=false;syncDispatchLinkedVisuals();for(const visualId of linkedIdsForChannel(id))tileUpdate(visualId);
 }
 dispatchPtt.classList.remove("active");
}
function tx(active){
 const requested=!!active;
 if(requested&&!radioPowered)return Promise.resolve();
 if(!requested){for(const c of connections.values())c.floorWakeResolver?.();stopLocalDispatchTransmitImmediately();}
 // Pointerup, pointercancel, lostpointercapture en de globale pointerup kunnen
 // dezelfde toestand meerdere keren melden. Plan alleen echte overgangen in.
 if(requested===dispatchTxRequested)return dispatchTxTransition;
 dispatchTxRequested=requested;
 const generation=++dispatchTxGeneration;
 if(requested)unmuteMasterForPtt();
 dispatchTxTransition=dispatchTxTransition
   .then(()=>performTx(requested,generation))
   .catch(error=>{console.error("Dispatch PTT-cyclus mislukt",error);if(generation===dispatchTxGeneration){setPttDisplayStatus("idle","Zendtoestemming niet beschikbaar","block")}});
 return dispatchTxTransition;
}
async function performTx(active,generation){
 let returnToStandby=false;
 if(active){
   if(generation!==dispatchTxGeneration||!dispatchTxRequested)return;
   dispatchBusyBuzzGeneration=-1;stopDispatchBusyBuzz();
   const proactive=txPermissionMode==="proactive";
   setPttDisplayStatus("idle",proactive?"Direct zenden · servercontrole":"Zendtoestemming aanvragen",proactive?"mic":"timer");
   // Heartbeat is nuttig, maar hoort in proactieve modus niet in het kritieke
   // audiopad. De floor-request blijft de autoritatieve servercontrole.
   if(proactive)void heartbeatDispatchSession(); else await heartbeatDispatchSession();
   const selectedIds=[...selected],targets=selectedIds.map(id=>[id,connections.get(id)]);
   if(!selectedIds.length||targets.some(([,connection])=>!connection)){
     logDispatchEvent("error","ptt_missing_stream",{selectedIds,connections:[...connections.keys()]});
     playDispatchErrorTone();setPttDisplayStatus("idle","Geselecteerd kanaal heeft geen mediasessie","block");return;
   }
   try{
     await Promise.all(selectedIds.map(id=>prepareDispatchChannelMicrophone(id)));
   }catch(error){
     logDispatchEvent("error","ptt_microphone_unavailable",{selectedIds,error:error?.message||String(error),name:error?.name||null});
     playDispatchErrorTone();
     setPttDisplayStatus("idle",error?.name==="NotAllowedError"?"Microfoontoegang geweigerd":"Microfoon niet beschikbaar","block");
     return;
   }

   if(proactive){
     // Optimistic floor: start alle geselecteerde WebRTC-tracks direct. De
     // floor-acquires gaan daarna parallel naar de server. Eén weigering trekt
     // de volledige multi-channel TX onmiddellijk in.
     try{
       await Promise.all(targets.map(async([id,c])=>{
         if(!c.livekit)throw new Error(`WebRTC op ${c.channelSlug} is niet verbonden`);
         await c.livekit.setTransmit(true);
         c.transmitting=true;c.optimisticTransmitting=true;
         const st=channelState.get(id);if(st)st.dispatcherDirect=true;syncDispatchLinkedVisuals();
         interruptCallRequestAlarm(id);tileUpdate(id);
       }));
       dispatchPtt.classList.add("active");
       playDispatchAcceptTone();
       refreshRadioDisplay();
     }catch(error){
       stopLocalDispatchTransmitImmediately();
       logDispatchEvent("error","ptt_proactive_media_start_failed",{error:error?.message||String(error),name:error?.name||null});
       playDispatchErrorTone();setPttDisplayStatus("idle","Microfoon kon niet starten","block");return;
     }
   }

   const grants=[];let failure=null,busyObserved=false;
   await Promise.all(targets.map(async([id,c])=>{
     try{
       if(!(await waitForDispatchSocket(c)))throw new Error("Controlverbinding is niet gereed");
       while(generation===dispatchTxGeneration&&dispatchTxRequested){
         const grant=await dispatchChannelPtt(c,"request",{client_request_id:`dispatch-${clientId}-${Date.now()}-${id}`,request_type:"normal"});
         if(grant.status==="granted"&&grant.floor_token){
           c.floorToken=grant.floor_token;
           grants.push({id,c,token:grant.floor_token});
           break;
         }
         if(grant.status==="waiting"){
           if(!busyObserved){
             busyObserved=true;
             // Proactief begon lokaal direct; zodra BUSY bekend is onmiddellijk
             // alle audio muten. De PTT blijft server-side in de wachtrij.
             if(proactive)stopLocalDispatchTransmitImmediately();
             void startDispatchBusyBuzz(generation);
           }
           const hold=grant.remaining_hold_ms!=null?` · overname ${Math.ceil(Number(grant.remaining_hold_ms)/100)/10}s`:"";
           setPttDisplayStatus("idle",`Kanaal bezet · wachten${hold}`,"hourglass_top");
           const retryMs=grant.remaining_hold_ms!=null?Math.max(50,Math.min(200,Number(grant.remaining_hold_ms)||200)):1000;
           await waitForDispatchFloorWake(c,retryMs);
           continue;
         }
         throw new Error("Zendtoestemming geweigerd");
       }
     }catch(error){
       logDispatchEvent("error","ptt_channel_failed",{channelId:id,channel:c.channelSlug,error:error.message,mode:txPermissionMode});
       failure=failure||error;
     }
   }));

   if(failure||grants.length!==targets.length||generation!==dispatchTxGeneration||!dispatchTxRequested){
     stopLocalDispatchTransmitImmediately();
     await Promise.all(targets.map(([id,c])=>{const token=c.floorToken||"";c.floorToken="";return dispatchChannelPtt(c,"release",{client_request_id:`dispatch-release-${clientId}-${Date.now()}-${id}`,floor_token:token}).catch(()=>{})}));
     if(generation===dispatchTxGeneration&&dispatchTxRequested&&failure){
       playDispatchErrorTone();setPttDisplayStatus("idle",failure?.message||"Zendtoestemming geweigerd","block");
     }
     return;
   }

   if(proactive){
     stopDispatchBusyBuzz();
     if(busyObserved){
       // Na queue-wacht/priority-overname was optimistic audio gemute. Nu alle
       // kanalen door de server zijn toegekend, meteen opnieuw unmute.
       await Promise.all(grants.map(async({c})=>{if(!c.livekit)throw new Error(`WebRTC op ${c.channelSlug} is niet verbonden`);await c.livekit.setTransmit(true)}));
       playDispatchAcceptTone();
     }
     for(const {id,c,token} of grants){
       c.floorToken=token;c.transmitting=true;c.optimisticTransmitting=false;
       const st=channelState.get(id);if(st)st.dispatcherDirect=true;syncDispatchLinkedVisuals();for(const visualId of linkedIdsForChannel(id))tileUpdate(visualId);
     }
   }else{
     const mediaStarted=[];
     try{
       await Promise.all(grants.map(async({id,c,token})=>{
         if(!c.livekit)throw new Error(`WebRTC op ${c.channelSlug} is niet verbonden`);
         await c.livekit.setTransmit(true);
         c.floorToken=token;c.transmitting=true;c.optimisticTransmitting=false;
         mediaStarted.push({id,c});
         const st=channelState.get(id);if(st)st.dispatcherDirect=true;syncDispatchLinkedVisuals();interruptCallRequestAlarm(id);for(const visualId of linkedIdsForChannel(id))tileUpdate(visualId);
       }));
     }catch(error){
       logDispatchEvent("error","ptt_microphone_start_failed",{error:error?.message||String(error),name:error?.name||null});
       stopLocalDispatchTransmitImmediately();
       await Promise.all(grants.map(({id,c,token})=>dispatchChannelPtt(c,"release",{client_request_id:`dispatch-release-${clientId}-${Date.now()}-${id}`,floor_token:token}).catch(()=>{})));
       playDispatchErrorTone();
       setPttDisplayStatus("idle",error?.name==="NotAllowedError"?"Microfoontoegang geweigerd":"Microfoon kon niet starten","block");
       return;
     }
   }

   if(activeCallRequest&&!activeCallRequest.cleared){
     try{
       await clearSelectedCallRequest();
       activeCallRequest=null;
       clearAudioPriority();
       renderRadioDisplay("idle");
     }catch(error){
       console.error("Contact request kon na PTT niet worden afgehandeld",error);
       logDispatchEvent("error","call_request_clear_failed",{requestId:activeCallRequest?.id,error:error.message});
     }
   }
   if(!proactive)playDispatchAcceptTone();
 }else{
   returnToStandby=!!activeCallRequest?.cleared;
   if(generation===dispatchTxGeneration)setPttDisplayStatus("idle","Zendtoestemming vrijgeven","hourglass_top");
   // Audio is al synchroon door tx(false) gemute. Hier worden alleen nog de
   // autoritatieve server-floors vrijgegeven.
   stopDispatchBusyBuzz();
   await Promise.all([...connections].map(async([id,c])=>{
     const token=c.floorToken;c.transmitting=false;c.optimisticTransmitting=false;c.floorToken="";
     const st=channelState.get(id);if(st)st.dispatcherDirect=false;syncDispatchLinkedVisuals();for(const visualId of linkedIdsForChannel(id))tileUpdate(visualId);
     // Ook zonder token: release-endpoint verwijdert een wachtende PTT direct
     // uit de server-side queue zodra de knop wordt losgelaten.
     await dispatchChannelPtt(c,"release",{client_request_id:`dispatch-release-${clientId}-${Date.now()}-${id}`,floor_token:token||""}).catch(error=>console.error(`PTT op kanaal ${c.channelSlug} kon niet worden vrijgegeven`,error));
   }));
   if(generation===dispatchTxGeneration)pttDisplayStatus=null;
 }
 const transmitting=[...connections.values()].some(c=>c.transmitting||c.optimisticTransmitting);
 if(transmitting){
   const focusCandidate=[...selected].reverse().find(id=>connections.get(id)?.transmitting||connections.get(id)?.optimisticTransmitting);
   if(focusCandidate)setAudioPriority(focusCandidate);
 }
 dispatchPtt.classList.toggle("active",transmitting);
 if(!active&&!transmitting&&returnToStandby){
   activeCallRequest=null;pttDisplayStatus=null;clearAudioPriority();renderRadioDisplay("idle");return;
 }
 refreshRadioDisplay();
}

let activePttPointerId=null;
function startPtt(event){
 if(event)event.preventDefault();
 if(dispatchPtt.disabled||!radioPowered||pttKeyDown)return;
 // Alleen primaire pointer-actie mag PTT starten. De knop is nadrukkelijk
 // momentary: pointerdown = zenden, loslaten/cancel = direct stoppen.
 if(event?.type==="pointerdown"&&event.button!==0)return;
 pttKeyDown=true;
 if(event?.type==="pointerdown")activePttPointerId=event.pointerId;
 dispatchPtt.classList.add("pressed");
 try{if(activePttPointerId!==null)dispatchPtt.setPointerCapture?.(activePttPointerId)}catch(_){}
 // Start microfoonvoorbereiding direct vanuit de gebruikersactie. Hierdoor
 // hangt getUserMedia niet achter heartbeat/floor-netwerkrequests.
 void prepareSelectedDispatchMicrophones();
 void tx(true);
}
function stopPtt(event){
 if(event)event.preventDefault();
 // Negeer alleen pointer-events van een andere gelijktijdige pointer.
 if(event?.pointerId!=null&&activePttPointerId!==null&&event.pointerId!==activePttPointerId)return;
 activePttPointerId=null;
 if(!pttKeyDown){
   dispatchPtt.classList.remove("pressed");
   return;
 }
 pttKeyDown=false;
 dispatchPtt.classList.remove("pressed");
 stopDispatchErrorTone();
 void tx(false);
}
dispatchPtt.addEventListener("pointerdown",startPtt);
dispatchPtt.addEventListener("pointerup",stopPtt);
dispatchPtt.addEventListener("pointercancel",stopPtt);
dispatchPtt.addEventListener("lostpointercapture",stopPtt);
// Een click mag nooit als toggle werken. Dit is tevens een fallback voor
// browsers die een pointerup buiten de knop vreemd afhandelen.
dispatchPtt.addEventListener("click",event=>{event.preventDefault();stopPtt(event)});
dispatchPtt.addEventListener("contextmenu",event=>event.preventDefault());
dispatchPtt.addEventListener("keydown",event=>{
 if((event.code==="Space"||event.code==="Enter")&&!event.repeat)startPtt(event);
});
dispatchPtt.addEventListener("keyup",event=>{
 if(event.code==="Space"||event.code==="Enter")stopPtt(event);
});
window.addEventListener("pointerup",stopPtt,true);
window.addEventListener("pointercancel",stopPtt,true);
window.addEventListener("blur",()=>stopPtt());
window.addEventListener("resize",()=>requestAnimationFrame(fitRadioDisplayText));
window.addEventListener("resize",()=>requestAnimationFrame(layoutAddressBookGroups));

window.addEventListener("dispatch-address-view",event=>{
 // /radio blijft altijd een actieve radio, ongeacht of in het adresboek de
 // Radio- of Kaartweergave zichtbaar is. De kaart is alleen een overlay.
 dispatchRadioViewActive=true;
 dispatchPtt.disabled=!radioPowered||!selected.size;
 // Re-assert de huidige RX/presence state zodat een viewwissel nooit media
 // of een geselecteerd kanaal kan muten/ontkoppelen.
 applyAudio();
 refreshRadioDisplay();
 renderSidebarButtons();
});
window.addEventListener("resize",()=>requestAnimationFrame(renderSidebarButtons));
if(window.ResizeObserver){new ResizeObserver(()=>renderSidebarButtons()).observe(document.querySelector("#sidebarButtonRail"));}
setInterval(()=>clock.textContent=new Date().toLocaleTimeString("nl-NL"),1000);
setRadioPower(false);
frontLeftVolume.value=masterLeft;
frontRightVolume.value=masterRight;
renderAssignedChannels();
renderAddressBookGroups();
renderDispatchButtons();
updateSpeakerMuteState();
overview();
void initDispatchMedia();
document.querySelector("#reconnectButton")?.addEventListener("click",()=>void reconnectDispatch());
window.addEventListener("offline",()=>{clearDispatchReconnectTimer();updateDispatchConnectionState();scheduleDispatchReconnect()});
window.addEventListener("online",()=>void reconnectDispatch());
setInterval(()=>{void heartbeatDispatchSession()},5000);
void refreshAddressBookConnectionStatus();
setInterval(refreshAddressBookConnectionStatus,5000);
void refreshCallRequests();
callRequestsRefreshTimer=setInterval(refreshCallRequests,2000);
callRequestAlarmTimer=setInterval(()=>{void servicePriorityOneAlarm()},250);
void refreshChannelPresence();
setInterval(refreshChannelPresence,2000);
document.addEventListener("pointerdown",()=>{void ensureDispatchAudioContext()}, {once:true,capture:true});
document.addEventListener("keydown",()=>{void ensureDispatchAudioContext()}, {once:true,capture:true});

window.getDispatchAudioDiagnostics=()=>[...connections.values()].map(c=>({channelId:c.channelId,channelSlug:c.channelSlug,transport:"webrtc",readyState:c.socket?.readyState??WebSocket.CLOSED,lastRoundtripMs:c.lastRoundtripMs,lastPongAt:c.lastPongAt,webrtcState:c.livekit?.connectionState||null}));

// Uniform dispatch scaling. We keep two stable logical layouts so the controls stay
// in the same relative positions on PC and on wide mobile landscape displays.
const DISPATCH_SCALE_LAYOUTS={
  pc:{width:1920,height:1056,header:48},
  mobile:{width:1600,height:696,header:48},
};
function applyDispatchViewportScale(){
  const root=document.querySelector('.dispatch-radio-screen');
  if(!root)return;
  const viewportWidth=Math.max(1,window.innerWidth||document.documentElement.clientWidth||1);
  const viewportHeight=Math.max(1,window.innerHeight||document.documentElement.clientHeight||1);
  const aspect=viewportWidth/viewportHeight;
  const mode=aspect>=2?'mobile':'pc';
  const layout=DISPATCH_SCALE_LAYOUTS[mode];
  // De schaal wordt primair door de beschikbare breedte bepaald. Op een
  // smal/hoger scherm vergroten we daarna de logische hoogte zodat de Dispatch
  // console altijd de volledige viewporthoogte benut in plaats van onderaan
  // een leeg blauw vlak over te houden.
  const widthScale=Math.min(1,viewportWidth/layout.width);
  const heightScale=Math.min(1,viewportHeight/layout.height);
  const scale=Math.min(widthScale,heightScale);

  const designWidth=scale>=1?Math.max(layout.width,viewportWidth):layout.width;
  const minimumDesignHeight=layout.height;
  const viewportDesignHeight=viewportHeight/Math.max(scale,0.0001);
  const designHeight=Math.max(minimumDesignHeight,viewportDesignHeight);
  const body=document.body;
  document.documentElement.classList.add('dispatch-scaled');
  body.classList.add('dispatch-scaled');
  body.classList.toggle('dispatch-aspect-mobile',mode==='mobile');
  body.classList.toggle('dispatch-aspect-pc',mode==='pc');
  body.style.setProperty('--dispatch-design-width',`${designWidth}px`);
  body.style.setProperty('--dispatch-design-height',`${designHeight}px`);
  body.style.setProperty('--dispatch-header-height',`${layout.header}px`);
  body.style.setProperty('--dispatch-scale',String(scale));
  body.dataset.dispatchLayout=mode;
  requestAnimationFrame(()=>{fitRadioDisplayText();layoutAddressBookGroups();renderSidebarButtons();});
}
applyDispatchViewportScale();
window.addEventListener('resize',()=>requestAnimationFrame(applyDispatchViewportScale));
window.addEventListener('orientationchange',()=>setTimeout(applyDispatchViewportScale,50));
