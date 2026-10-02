(()=>{
  "use strict";

  const tenantSlug=document.body.dataset.tenantSlug||"";
  const tenant=encodeURIComponent(tenantSlug);
  const MAP_STATE_KEY=`dispatch-map-state:${tenantSlug}`;
  const BENELUX_BOUNDS=[[49.45,2.45],[53.75,7.45]];
  const LOCATION_MAX_AGE_MS=5*60*1000;
  const FULL_SYNC_MS=5000;
  const HIGHLIGHT_MS=5000;

  const markers=new Map();
  const channelLayers=new Map();
  const searchWidgets=[];
  let map=null;
  let mapElement=null;
  let emptyElement=null;
  let timer=null;
  let inlineVisible=false;
  let latestRadios=[];
  let baseEntries={};
  let currentBaseName="OpenStreetMap";
  let controls=null;
  let realtimeSocket=null;
  let realtimeReconnectTimer=null;
  let realtimeConnecting=false;
  let initialDataEvaluated=false;

  const storedView=loadStoredView();
  let userInteracted=Boolean(storedView?.userInteracted);
  let autoViewEligible=storedView ? Boolean(storedView.autoPending)&&!userInteracted : true;
  let fitted=storedView ? !autoViewEligible : false;

  function escapeHtml(value){
    return String(value??"").replace(/[&<>'"]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch]));
  }

  function formatAge(timestampMs){
    const value=Number(timestampMs||0);
    if(!value)return "onbekend";
    const seconds=Math.max(0,Math.round((Date.now()-value)/1000));
    if(seconds<60)return `${seconds}s geleden`;
    const minutes=Math.round(seconds/60);
    if(minutes<60)return `${minutes} min geleden`;
    return `${Math.round(minutes/60)} uur geleden`;
  }

  function loadStoredView(){
    try{
      const value=JSON.parse(sessionStorage.getItem(MAP_STATE_KEY)||"null");
      if(!value||!Number.isFinite(Number(value.zoom))||!Number.isFinite(Number(value.lat))||!Number.isFinite(Number(value.lng)))return null;
      return value;
    }catch(_){return null;}
  }

  function saveMapState(){
    if(!map)return;
    const center=map.getCenter();
    try{
      sessionStorage.setItem(MAP_STATE_KEY,JSON.stringify({
        lat:center.lat,
        lng:center.lng,
        zoom:map.getZoom(),
        userInteracted,
        autoPending:Boolean(autoViewEligible&&!fitted&&!userInteracted),
      }));
    }catch(_){}
  }

  function markUserInteracted(){
    userInteracted=true;
    autoViewEligible=false;
    saveMapState();
  }

  function normalizeSearch(value){
    return String(value??"").toLocaleLowerCase("nl-NL").normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
  }

  function scoreRadio(radio,query){
    const q=normalizeSearch(query);
    if(!q)return -1;
    const name=normalizeSearch(radio?.name),slug=normalizeSearch(radio?.slug),channel=normalizeSearch(radio?.channel),status=normalizeSearch(radio?.frontend_status);
    let score=0;
    if(name===q)score+=1000;
    if(name.startsWith(q))score+=700;else if(name.includes(q))score+=500;
    if(slug===q)score+=350;else if(slug.startsWith(q))score+=220;else if(slug.includes(q))score+=150;
    if(channel.startsWith(q))score+=90;else if(channel.includes(q))score+=60;
    if(status.includes(q))score+=25;
    if(radio?.location)score+=10;
    return score;
  }

  function matchingRadios(query){
    const q=normalizeSearch(query);
    if(!q)return [];
    return latestRadios.map(radio=>({radio,score:scoreRadio(radio,q)})).filter(item=>item.score>0)
      .sort((a,b)=>b.score-a.score||String(a.radio?.name||"").localeCompare(String(b.radio?.name||""),"nl"))
      .slice(0,5).map(item=>item.radio);
  }


  function updateEmptyStateFromMarkers(){
    if(!emptyElement)return;
    // This must only be called AFTER all marker additions/updates/removals for
    // the current update cycle are complete. The final marker set is the
    // single source of truth for the empty-state.
    emptyElement.hidden=markers.size>0;
  }

  function normalizeTimestampMs(value){
    let ts=Number(value||0);
    if(!Number.isFinite(ts)||ts<=0)return 0;
    // Defensive support for a seconds timestamp while the canonical API uses ms.
    if(ts<1e12)ts*=1000;
    return ts;
  }

  function isRecentReliableLocation(location){
    if(!location)return false;
    const lat=Number(location.latitude),lng=Number(location.longitude);
    const accuracy=Number(location.accuracy_m),ts=normalizeTimestampMs(location.timestamp_ms);
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return false;
    if(!Number.isFinite(accuracy)||accuracy>=25)return false;
    if(!ts)return false;
    const ageMs=Date.now()-ts;
    // Allow a small clock skew, but never keep a genuinely stale point.
    return ageMs<=LOCATION_MAX_AGE_MS&&ageMs>=-60*1000;
  }

  function radioLatLng(radio){
    const loc=radio?.location;if(!isRecentReliableLocation(loc))return null;
    return [Number(loc.latitude),Number(loc.longitude)];
  }

  function mergeRadiosPreservingRecentLocations(incoming){
    const previous=new Map(latestRadios.map(radio=>[String(radio?.id??""),radio]));
    return incoming.map(radio=>{
      const old=previous.get(String(radio?.id??""));
      const incomingValid=isRecentReliableLocation(radio?.location);
      const oldValid=isRecentReliableLocation(old?.location);
      if(!incomingValid&&oldValid){
        return {...radio,location:old.location};
      }
      return radio;
    });
  }

  function currentLocationBounds(){
    return latestRadios.map(radioLatLng).filter(Boolean);
  }

  function autoFitRadios(bounds){
    if(!map||!bounds?.length)return false;
    map.fitBounds(L.latLngBounds(bounds),{padding:[32,32],maxZoom:15,animate:false});
    fitted=true;
    autoViewEligible=false;
    saveMapState();
    return true;
  }

  function fitVisibleRadios(){
    if(!map)return;
    markUserInteracted();
    const bounds=[];
    for(const entry of markers.values()){
      if(entry.layer&&map.hasLayer(entry.layer))bounds.push(entry.marker.getLatLng());
    }
    if(bounds.length)map.fitBounds(L.latLngBounds(bounds),{padding:[32,32],maxZoom:15});
    else map.fitBounds(BENELUX_BOUNDS,{padding:[24,24]});
  }

  function centerOnRadio(radio){
    if(!map)return false;
    const pos=radioLatLng(radio);if(!pos)return false;
    markUserInteracted();
    map.panTo(pos,{animate:true,duration:.35});
    const entry=markers.get(String(radio.id));
    if(entry){
      const layerEntry=channelLayers.get(String(radio.channel_id||"unassigned"));
      if(layerEntry&&!map.hasLayer(layerEntry.layer))map.addLayer(layerEntry.layer);
      setTimeout(()=>{entry.marker.openPopup?.();requestAnimationFrame(updateMarkerStacks);},380);
    }
    return true;
  }

  function renderSearch(widget){
    const {input,results}=widget,matches=matchingRadios(input.value);
    results.replaceChildren();
    if(!normalizeSearch(input.value)){results.hidden=true;input.setAttribute("aria-expanded","false");return;}
    if(!matches.length){
      const empty=document.createElement("div");empty.className="dispatch-map-search-empty";empty.textContent="Geen radio gevonden";results.appendChild(empty);
    }else{
      for(const radio of matches){
        const button=document.createElement("button");button.type="button";button.className="dispatch-map-search-result";button.setAttribute("role","option");
        const hasLocation=Boolean(radioLatLng(radio));if(!hasLocation)button.classList.add("no-location");
        button.innerHTML=`<span class="material-symbols-rounded">mobile</span><span class="dispatch-map-search-result-text"><strong>${escapeHtml(radio.name)}</strong><small>${escapeHtml(hasLocation?(radio.channel||"Niet toegewezen"):"Geen recente locatie")}</small></span>`;
        button.addEventListener("click",()=>{input.value=radio.name||"";results.hidden=true;input.setAttribute("aria-expanded","false");if(hasLocation)centerOnRadio(radio);});
        results.appendChild(button);
      }
    }
    results.hidden=false;input.setAttribute("aria-expanded","true");
  }

  function initSearchWidgets(){
    document.querySelectorAll("[data-map-search]").forEach(host=>{
      if(host.dataset.searchReady==="1")return;
      const input=host.querySelector("[data-map-search-input]"),results=host.querySelector("[data-map-search-results]");if(!input||!results)return;
      host.dataset.searchReady="1";const widget={host,input,results};searchWidgets.push(widget);
      input.addEventListener("input",()=>renderSearch(widget));
      input.addEventListener("focus",()=>{if(normalizeSearch(input.value))renderSearch(widget);});
      input.addEventListener("keydown",event=>{
        if(event.key==="Escape"){results.hidden=true;input.setAttribute("aria-expanded","false");input.blur();}
        if(event.key==="Enter"){const first=matchingRadios(input.value)[0];if(first?.location){event.preventDefault();input.value=first.name||"";results.hidden=true;input.setAttribute("aria-expanded","false");centerOnRadio(first);}}
      });
      document.addEventListener("pointerdown",event=>{if(!host.contains(event.target)){results.hidden=true;input.setAttribute("aria-expanded","false");}});
    });
  }

  function baseLayers(){
    return {
      "OpenStreetMap":L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}),
      "Esri Light":L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",{maxZoom:16,attribution:"Tiles &copy; Esri"}),
      "Esri Dark":L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",{maxZoom:16,attribution:"Tiles &copy; Esri"}),
    };
  }

  function setBaseLayer(name){
    const layer=baseEntries[name];if(!map||!layer)return;
    for(const candidate of Object.values(baseEntries))if(map.hasLayer(candidate))map.removeLayer(candidate);
    layer.addTo(map);currentBaseName=name;renderLayerPanel();
  }

  function renderLayerPanel(){
    if(!controls?.layerPanel)return;
    const panel=controls.layerPanel;panel.replaceChildren();
    const baseTitle=document.createElement("strong");baseTitle.textContent="Kaart";panel.appendChild(baseTitle);
    for(const name of Object.keys(baseEntries)){
      const label=document.createElement("label");label.className="dispatch-map-layer-row";
      const input=document.createElement("input");input.type="radio";input.name="dispatch-map-base";input.checked=name===currentBaseName;input.addEventListener("change",()=>setBaseLayer(name));
      label.append(input,document.createTextNode(name));panel.appendChild(label);
    }
    const channelTitle=document.createElement("strong");channelTitle.textContent="Kanalen";panel.appendChild(channelTitle);
    [...channelLayers.entries()].sort((a,b)=>a[1].name.localeCompare(b[1].name,"nl")).forEach(([id,entry])=>{
      const label=document.createElement("label");label.className="dispatch-map-layer-row";
      const input=document.createElement("input");input.type="checkbox";input.checked=map.hasLayer(entry.layer);
      input.addEventListener("change",()=>{if(input.checked)map.addLayer(entry.layer);else map.removeLayer(entry.layer);requestAnimationFrame(updateMarkerStacks);});
      label.append(input,document.createTextNode(entry.name));panel.appendChild(label);
    });
  }

  function createMapControls(){
    const Control=L.Control.extend({onAdd(){
      const host=L.DomUtil.create("div","dispatch-map-control-stack leaflet-bar");
      L.DomEvent.disableClickPropagation(host);L.DomEvent.disableScrollPropagation(host);
      const makeButton=(icon,title,handler,textIcon=false)=>{
        const button=L.DomUtil.create("button","dispatch-map-control-button",host);button.type="button";button.title=title;button.setAttribute("aria-label",title);
        button.innerHTML=textIcon?escapeHtml(icon):`<span class="material-symbols-rounded" aria-hidden="true">${escapeHtml(icon)}</span>`;
        button.addEventListener("click",event=>{event.preventDefault();handler(button);});return button;
      };
      makeButton("+","Inzoomen",()=>{markUserInteracted();map.zoomIn();},true);
      makeButton("−","Uitzoomen",()=>{markUserInteracted();map.zoomOut();},true);
      const layersButton=makeButton("layers","Kaartlagen",()=>{controls.layerPanel.hidden=!controls.layerPanel.hidden;});
      makeButton("background_dot_small","Pas kaart aan op zichtbare radio's",()=>fitVisibleRadios());
      makeButton("open_in_new","Open kaart in nieuw scherm",()=>window.open(`/dispatch/${tenant}/map`,`_blank`,`noopener,noreferrer`));
      const layerPanel=L.DomUtil.create("div","dispatch-map-layer-panel",host);layerPanel.hidden=true;
      controls={host,layersButton,layerPanel};
      renderLayerPanel();
      return host;
    }});return new Control({position:"topleft"});
  }

  function ensureMap(elementId,emptyId){
    if(map)return map;
    mapElement=document.getElementById(elementId);emptyElement=document.getElementById(emptyId);if(!mapElement||!window.L)return null;
    baseEntries=baseLayers();
    map=L.map(mapElement,{zoomControl:false,attributionControl:true,layers:[baseEntries[currentBaseName]]});
    if(storedView)map.setView([Number(storedView.lat),Number(storedView.lng)],Number(storedView.zoom),{animate:false});
    else map.fitBounds(BENELUX_BOUNDS,{padding:[24,24],animate:false});
    createMapControls().addTo(map);
    mapElement.addEventListener("pointerdown",markUserInteracted,{passive:true});
    mapElement.addEventListener("wheel",markUserInteracted,{passive:true});
    map.on("zoomend moveend overlayadd overlayremove",()=>{saveMapState();requestAnimationFrame(updateMarkerStacks);});
    renderLayerPanel();connectRealtime();return map;
  }

  function ensureChannelLayer(channelId,channelName){
    const id=String(channelId||"unassigned");let entry=channelLayers.get(id);if(entry)return entry.layer;
    const layer=L.layerGroup().addTo(map);entry={layer,name:channelName||"Niet toegewezen"};channelLayers.set(id,entry);renderLayerPanel();return layer;
  }

  function popupHtml(radio,location){
    const accuracy=Number(location.accuracy_m),accuracyText=Number.isFinite(accuracy)?`${Math.round(accuracy)} m`:"onbekend";
    const channelId=String(radio.channel_id||"");
    const selectButton=channelId&&channelId!=="unassigned"&&radio.channel
      ? `<button type="button" class="dispatch-map-select-tx" data-channel-id="${escapeHtml(channelId)}" data-channel-name="${escapeHtml(radio.channel)}">Dispatch TX op ${escapeHtml(radio.channel)}</button>`
      : "";
    return `<div class="dispatch-map-popup"><strong>${escapeHtml(radio.name)}</strong>${radio.transmitting?'<div><strong>TX actief</strong></div>':""}${radio.frontend_status?`<div>${escapeHtml(radio.frontend_status)}</div>`:""}${radio.channel?`<div>Kanaal: ${escapeHtml(radio.channel)}</div>`:""}<div>Accuracy: ${accuracyText}</div><div>${escapeHtml(formatAge(location.timestamp_ms))}</div>${selectButton}</div>`;
  }

  function cookieValue(name){
    const match=document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}=([^;]*)`));
    return match?match[1]:"";
  }

  async function selectDispatchTxFromMap(channelId,button){
    const id=String(channelId||"");
    if(!id)return;
    const original=button?.textContent||"Selecteer als Dispatch TX";
    if(button){button.disabled=true;button.textContent="Instellen…";}
    try{
      let selectedNow=false;
      if(window.DispatchRadio?.selectTxChannel){
        selectedNow=Boolean(window.DispatchRadio.selectTxChannel(id));
      }
      if(!selectedNow){
        const response=await fetch(`/dispatch/${tenant}/api/radio-settings/`,{
          method:"POST",credentials:"same-origin",cache:"no-store",
          headers:{"Content-Type":"application/json","X-CSRFToken":decodeURIComponent(cookieValue("csrftoken"))},
          body:JSON.stringify({radio_settings:{radio:{selectedTxChannelId:id}}}),
        });
        const payload=await response.json().catch(()=>({}));
        if(!response.ok||payload.ok===false)throw new Error(payload.detail||payload.error||`HTTP ${response.status}`);
      }
      if("BroadcastChannel" in window){
        const bus=new BroadcastChannel(`dispatch-tx-channel:${tenantSlug}`);
        bus.postMessage({type:"select-tx-channel",channelId:id});
        bus.close();
      }
      if(button){button.textContent="Dispatch TX ingesteld";button.classList.add("is-selected");}
    }catch(error){
      console.error("Dispatch TX-kanaal kon niet via de kaart worden ingesteld",error);
      if(button){button.disabled=false;button.textContent="Instellen mislukt – opnieuw";}
      return;
    }
    if(button)setTimeout(()=>{button.disabled=false;button.textContent=original;button.classList.remove("is-selected");},1400);
  }

  document.addEventListener("click",event=>{
    const button=event.target.closest?.(".dispatch-map-select-tx[data-channel-id]");
    if(!button)return;
    event.preventDefault();
    event.stopPropagation();
    void selectDispatchTxFromMap(button.dataset.channelId,button);
  });

  function radioVisualSignature(radio){
    return JSON.stringify({name:String(radio?.name||""),color:String(radio?.status_color||"#495057"),border:String(radio?.status_border_color||"#212529"),iconBg:String(radio?.status_icon_bg_color||"#49505733")});
  }

  function radioIcon(radio){
    const color=String(radio.status_color||"#495057");
    const border=String(radio.status_border_color||"#212529");
    const iconBg=String(radio.status_icon_bg_color||`${color}33`);
    return L.divIcon({className:"dispatch-radio-div-icon",html:`<div class="dispatch-radio-map-marker" style="--status-color:${escapeHtml(color)};--status-border-color:${escapeHtml(border)};--status-icon-bg-color:${escapeHtml(iconBg)}"><div class="dispatch-radio-map-badge"><span class="dispatch-radio-map-icon material-symbols-rounded">mobile</span><span class="dispatch-radio-map-label">${escapeHtml(radio.name)}</span><span class="dispatch-radio-map-pointer" aria-hidden="true"></span></div></div>`,iconSize:[130,44],iconAnchor:[14,41],popupAnchor:[0,-36]});
  }

  function updateMarkerVisual(entry,radio){
    const inner=entry.marker.getElement?.()?.querySelector?.(".dispatch-radio-map-marker");
    if(!inner)return false;
    const badge=inner.querySelector(".dispatch-radio-map-badge");
    const label=inner.querySelector(".dispatch-radio-map-label");
    const color=String(radio?.status_color||"#495057");
    const border=String(radio?.status_border_color||"#212529");
    const iconBg=String(radio?.status_icon_bg_color||`${color}33`);
    inner.style.setProperty("--status-color",color);
    inner.style.setProperty("--status-border-color",border);
    inner.style.setProperty("--status-icon-bg-color",iconBg);
    inner.classList.toggle("is-transmitting",radio?.transmitting===true);
    if(label&&label.textContent!==String(radio?.name||""))label.textContent=String(radio?.name||"");
    if(badge)badge.setAttribute("data-radio-name",String(radio?.name||""));
    return true;
  }

  function rectanglesOverlap(a,b,padding=0){return !(a.right+padding<=b.left||a.left-padding>=b.right||a.bottom+padding<=b.top||a.top-padding>=b.bottom);}

  function updateMarkerStacks(){
    if(!map)return;
    const visible=[];
    for(const entry of markers.values()){
      const el=entry.marker.getElement?.(),inner=el?.querySelector?.(".dispatch-radio-map-marker");
      if(!el||!inner||!map.getBounds().contains(entry.marker.getLatLng())||!map.hasLayer(entry.layer))continue;
      inner.classList.remove("is-stacked","is-stack-first","is-stack-middle","is-stack-last");
      inner.style.setProperty("--stack-x","0px");
      inner.style.setProperty("--stack-y","0px");
      inner.style.removeProperty("--stack-width");
      inner.style.zIndex="";
      visible.push({entry,inner,rect:inner.getBoundingClientRect()});
    }
    if(visible.length<2)return;

    const parent=visible.map((_,i)=>i);
    const find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
    const unite=(a,b)=>{const ra=find(a),rb=find(b);if(ra!==rb)parent[rb]=ra;};
    for(let i=0;i<visible.length;i++){
      for(let j=i+1;j<visible.length;j++){
        if(rectanglesOverlap(visible[i].rect,visible[j].rect,12))unite(i,j);
      }
    }

    const grouped=new Map();
    visible.forEach((item,index)=>{const root=find(index);if(!grouped.has(root))grouped.set(root,[]);grouped.get(root).push(item);});

    for(const group of grouped.values()){
      if(group.length<2)continue;

      // A grouped marker is always deterministic: alphabetical by radio name.
      group.sort((a,b)=>String(a.entry.name||"").localeCompare(String(b.entry.name||""),"nl",{sensitivity:"base"}));

      const stackLeft=Math.min(...group.map(item=>item.rect.left));
      const stackTop=Math.min(...group.map(item=>item.rect.top));
      const stackWidth=Math.ceil(Math.max(...group.map(item=>item.rect.width)));
      let nextTop=stackTop;

      group.forEach((item,index)=>{
        const x=Math.round(stackLeft-item.rect.left);
        const y=Math.round(nextTop-item.rect.top);
        item.inner.classList.add("is-stacked");
        if(index===0)item.inner.classList.add("is-stack-first");
        else if(index===group.length-1)item.inner.classList.add("is-stack-last");
        else item.inner.classList.add("is-stack-middle");
        item.inner.style.setProperty("--stack-x",`${x}px`);
        item.inner.style.setProperty("--stack-y",`${y}px`);
        item.inner.style.setProperty("--stack-width",`${stackWidth}px`);
        item.inner.style.zIndex=String(2000+(group.length-index));

        // Overlap the borders by 2px so the rows visually form one large marker.
        nextTop+=Math.max(1,Math.ceil(item.rect.height)-2);
      });
    }
  }

  function moveMarkerToLayer(entry,channelId,channelName){
    const wantedId=String(channelId||"unassigned");if(entry.channelId===wantedId)return;
    if(entry.layer)entry.layer.removeLayer(entry.marker);const layer=ensureChannelLayer(wantedId,channelName);layer.addLayer(entry.marker);entry.layer=layer;entry.channelId=wantedId;
  }

  function upsertRadio(radio){
    const pos=radioLatLng(radio);if(!pos)return null;
    const [lat,lng]=pos,id=String(radio.id),channelId=String(radio.channel_id||"unassigned");let entry=markers.get(id);
    if(!entry){
      const marker=L.marker([lat,lng],{icon:radioIcon(radio),riseOnHover:true}),layer=ensureChannelLayer(channelId,radio.channel);marker.addTo(layer);
      entry={marker,layer,channelId,tx:Boolean(radio.transmitting),name:radio.name,visualSignature:radioVisualSignature(radio),highlighted:false,highlightTimer:null};markers.set(id,entry);
      requestAnimationFrame(()=>updateMarkerVisual(entry,radio));
    }else{
      const current=entry.marker.getLatLng();if(current.lat!==lat||current.lng!==lng)entry.marker.setLatLng([lat,lng]);
      moveMarkerToLayer(entry,channelId,radio.channel);entry.tx=Boolean(radio.transmitting);entry.name=radio.name;
      const nextSignature=radioVisualSignature(radio);
      updateMarkerVisual(entry,radio);
      entry.visualSignature=nextSignature;
    }
    entry.marker.bindPopup(popupHtml(radio,radio.location));
    if(entry.highlighted)requestAnimationFrame(()=>entry.marker.getElement?.()?.querySelector?.(".dispatch-radio-map-marker")?.classList.add("is-highlighted"));
    return entry;
  }

  async function refresh(){
    if(!map)return;
    try{
      const response=await fetch(`/dispatch/${tenant}/api/locations/`,{credentials:"same-origin",cache:"no-store"}),payload=await response.json();
      if(!response.ok||payload.ok===false)throw new Error(payload.error||`HTTP ${response.status}`);
      const incomingRadios=Array.isArray(payload.radios)?payload.radios:[];
      // Replace the data set atomically. If a refresh temporarily omits a
      // location, preserve the last reliable (<25 m), <5 minute fix so the
      // marker and empty-state do not flicker between polling/WebSocket updates.
      latestRadios=mergeRadiosPreservingRecentLocations(incomingRadios);
      for(const widget of searchWidgets)if(document.activeElement===widget.input&&normalizeSearch(widget.input.value))renderSearch(widget);
      const seen=new Set(),bounds=[];
      for(const channel of Array.isArray(payload.channels)?payload.channels:[])ensureChannelLayer(channel.id,channel.name);
      for(const radio of latestRadios){const pos=radioLatLng(radio);if(!pos)continue;seen.add(String(radio.id));bounds.push(pos);upsertRadio(radio);}
      for(const [id,entry] of markers)if(!seen.has(id)){if(entry.highlightTimer)clearTimeout(entry.highlightTimer);entry.layer?.removeLayer(entry.marker);markers.delete(id);}
      // Only decide the empty-state after the marker layer has been fully
      // synchronized. This avoids evaluating a temporary in-between state.
      updateEmptyStateFromMarkers();
      if(!initialDataEvaluated){initialDataEvaluated=true;if(!storedView&&bounds.length)autoFitRadios(bounds);}
      else if(!fitted&&autoViewEligible&&!userInteracted&&bounds.length)autoFitRadios(bounds);
      renderLayerPanel();requestAnimationFrame(updateMarkerStacks);
    }catch(error){console.warn("Dispatch locaties konden niet worden geladen",error);}
  }

  function applyRealtimeLocation(message){
    if(!map||message?.type!=="radio_location")return;
    const id=String(message.radio_id||""),radio=latestRadios.find(item=>String(item.id)===id);
    if(!radio){void refresh();return;}

    const candidate={
      latitude:Number(message.latitude),
      longitude:Number(message.longitude),
      accuracy_m:Number(message.accuracy_m),
      timestamp_ms:Number(message.timestamp_ms),
    };

    // Realtime updates (including the extra PTT fix) may never replace a
    // still-valid <25 m / <5 minute map position with an unreliable point.
    if(!isRecentReliableLocation(candidate))return;

    radio.location=candidate;
    upsertRadio(radio);
    // The marker update is complete; now evaluate the final marker set.
    updateEmptyStateFromMarkers();
    if(!fitted&&autoViewEligible&&!userInteracted){const bounds=currentLocationBounds();if(bounds.length)autoFitRadios(bounds);}
    for(const widget of searchWidgets)if(document.activeElement===widget.input&&normalizeSearch(widget.input.value))renderSearch(widget);
    requestAnimationFrame(updateMarkerStacks);
  }

  async function connectRealtime(){
    if(realtimeConnecting||realtimeSocket?.readyState===WebSocket.OPEN)return;
    realtimeConnecting=true;
    try{
      const response=await fetch(`/dispatch/${tenant}/api/media-bootstrap/`,{credentials:"same-origin",cache:"no-store"}),payload=await response.json();
      if(!response.ok||payload.ok===false)throw new Error(payload.detail||payload.error||`HTTP ${response.status}`);
      const audio=payload?.data?.audio||{},protocol=location.protocol==="https:"?"wss":"ws",params=new URLSearchParams({session_id:String(audio.session_id||""),access_token:String(audio.access_token||"")});
      if(!audio.session_id||!audio.access_token)throw new Error("Geen dispatch sessie voor realtime kaart");
      const socket=new WebSocket(`${protocol}://${location.host}/poc/ws/v1/map/${tenant}/?${params}`);realtimeSocket=socket;
      socket.onmessage=event=>{try{applyRealtimeLocation(JSON.parse(event.data));}catch(_){}};
      socket.onclose=()=>{if(realtimeSocket===socket)realtimeSocket=null;clearTimeout(realtimeReconnectTimer);realtimeReconnectTimer=setTimeout(()=>void connectRealtime(),5000);};
      socket.onerror=()=>socket.close();
    }catch(error){console.warn("Realtime kaartverbinding niet beschikbaar",error);clearTimeout(realtimeReconnectTimer);realtimeReconnectTimer=setTimeout(()=>void connectRealtime(),5000);}
    finally{realtimeConnecting=false;}
  }

  async function highlightRadio(target){
    if(!map)showInlineMap();

    const wanted=normalizeSearch(target);
    const findRadio=()=>latestRadios.find(item=>
      String(item.id)===String(target)||
      normalizeSearch(item.slug)===wanted||
      normalizeSearch(item.name)===wanted
    );

    if(!latestRadios.length)await refresh();
    let radio=findRadio();
    let entry=radio?markers.get(String(radio.id)):null;

    // A visual scale/highlight must never invalidate location state. If the
    // marker is already on the map, its LatLng is the last accepted reliable
    // position and can safely be used even while an API/PTT refresh is in
    // flight or temporarily omits the location field.
    if(!entry){
      if(!radio||!radioLatLng(radio)){
        await refresh();
        radio=findRadio();
      }
      if(!radio)return false;
      entry=markers.get(String(radio.id));
      if(!entry){
        if(!radioLatLng(radio))return false;
        entry=upsertRadio(radio);
      }
    }
    if(!entry)return false;

    const layerEntry=radio?channelLayers.get(String(radio.channel_id||"unassigned")):null;
    if(layerEntry&&!map.hasLayer(layerEntry.layer))map.addLayer(layerEntry.layer);

    const markerLatLng=entry.marker.getLatLng();
    if(!map.getBounds().contains(markerLatLng)){
      markUserInteracted();
      map.panTo(markerLatLng,{animate:true,duration:.35});
    }

    entry.highlighted=true;
    if(entry.highlightTimer)clearTimeout(entry.highlightTimer);
    const apply=()=>entry.marker.getElement?.()?.querySelector?.(".dispatch-radio-map-marker")?.classList.add("is-highlighted");
    requestAnimationFrame(apply);
    entry.highlightTimer=setTimeout(()=>{
      entry.highlighted=false;
      entry.marker.getElement?.()?.querySelector?.(".dispatch-radio-map-marker")?.classList.remove("is-highlighted");
      requestAnimationFrame(updateMarkerStacks);
    },HIGHLIGHT_MS);
    requestAnimationFrame(updateMarkerStacks);
    return true;
  }

  function startPolling(){if(timer)return;void refresh();timer=setInterval(()=>void refresh(),FULL_SYNC_MS);}

  function initFull(){if(!document.getElementById("dispatchFullMap"))return false;ensureMap("dispatchFullMap","dispatchFullMapEmpty");initSearchWidgets();startPolling();return true;}

  function showInlineMap(){
    const host=document.querySelector(".address-book"),view=document.getElementById("addressBookMapView"),networkView=document.getElementById("addressBookNetworkView"),statesView=document.getElementById("addressBookStatesView");if(!host||!view)return;
    if(networkView)networkView.hidden=true;
    if(statesView)statesView.hidden=true;
    host.classList.remove("network-mode","states-mode");
    view.hidden=false;host.classList.add("map-mode");inlineVisible=true;ensureMap("dispatchInlineMap","dispatchInlineMapEmpty");initSearchWidgets();startPolling();
    requestAnimationFrame(()=>{map?.invalidateSize();void refresh();});window.dispatchEvent(new CustomEvent("dispatch-address-view",{detail:{view:"map"}}));
  }

  function showInlineRadio(){
    const host=document.querySelector(".address-book"),view=document.getElementById("addressBookMapView"),networkView=document.getElementById("addressBookNetworkView"),statesView=document.getElementById("addressBookStatesView");if(!host||!view)return;
    host.classList.remove("map-mode","network-mode","states-mode");view.hidden=true;if(networkView)networkView.hidden=true;if(statesView)statesView.hidden=true;inlineVisible=false;window.dispatchEvent(new CustomEvent("dispatch-address-view",{detail:{view:"radio"}}));
  }

  function currentView(){return inlineVisible?"map":"radio";}

  window.DispatchMap={showInlineMap,showInlineRadio,currentView,refresh,centerOnRadio,highlightRadio,fitVisibleRadios};
  if(!initFull()&&document.getElementById("dispatchInlineMap")){}
  const clock=document.getElementById("clock");if(clock&&!window.__dispatchMapClock){window.__dispatchMapClock=true;const tick=()=>clock.textContent=new Date().toLocaleTimeString("nl-NL");tick();setInterval(tick,1000);}
})();
