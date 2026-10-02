(()=>{
  "use strict";

  const tenantRaw=document.body?.dataset?.tenantSlug||"";
  if(!tenantRaw)return;
  const tenant=encodeURIComponent(tenantRaw);
  const alert=document.getElementById("dispatchHeartbeatAlert");
  const userLabel=document.getElementById("dispatchHeartbeatUser");
  const selectedDispatcher=(document.body?.dataset?.dispatchUser||"").trim();
  const INTERVAL_MS=5000;
  const LOST_AFTER_MS=15000;
  const clock=document.getElementById("clock");

  function updateClock(){
    if(clock)clock.textContent=new Date().toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
  }
  updateClock();
  setInterval(updateClock,1000);
  let lastSuccessAt=0;
  let startedAt=Date.now();
  let running=false;

  if(userLabel&&selectedDispatcher)userLabel.textContent=` · ${selectedDispatcher}`;

  function cookieValue(name){
    for(const part of document.cookie.split(";")){
      const item=part.trim();
      if(item.startsWith(`${name}=`))return item.slice(name.length+1);
    }
    return "";
  }

  function setLost(lost){
    if(!alert)return;
    alert.hidden=!lost;
    document.body.classList.toggle("dispatch-heartbeat-lost",!!lost);
  }

  function evaluate(){
    const reference=lastSuccessAt||startedAt;
    setLost(Date.now()-reference>LOST_AFTER_MS);
  }

  async function sendHeartbeat(){
    if(running)return;
    running=true;
    try{
      const response=await fetch(`/dispatch/${tenant}/api/heartbeat/`,{
        method:"POST",
        credentials:"same-origin",
        cache:"no-store",
        headers:{
          "Content-Type":"application/json",
          "X-CSRFToken":decodeURIComponent(cookieValue("csrftoken")),
        },
        // Geen telemetry meesturen: de radio-tab beheert de WebRTC/radio telemetry.
        // Dit is alleen de scherm-heartbeat voor de geselecteerde dispatcher.
        body:"{}",
      });
      if(response.ok){
        lastSuccessAt=Date.now();
        setLost(false);
      }else{
        evaluate();
      }
    }catch(_){
      evaluate();
    }finally{
      running=false;
    }
  }

  void sendHeartbeat();
  setInterval(()=>void sendHeartbeat(),INTERVAL_MS);
  setInterval(evaluate,1000);
  window.addEventListener("online",()=>void sendHeartbeat());
  window.addEventListener("offline",evaluate);
})();
