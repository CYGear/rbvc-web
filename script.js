// --- Firebase ---
const firebaseConfig = {
  apiKey: "AIzaSyDoYmkPcR741Emh6PYIcUZQs745t8YhZXg",
  authDomain: "rbvc-cee15.firebaseapp.com",
  databaseURL: "https://rbvc-cee15-default-rtdb.firebaseio.com",
  projectId: "rbvc-cee15",
  storageBucket: "rbvc-cee15.firebasestorage.app",
  messagingSenderId: "290377633193",
  appId: "1:290377633193:web:ec54560fa4ca6294e308b8",
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const $ = id => document.getElementById(id);
const joinCard = $("joinCard");
const bubbles  = $("bubbles");
const statusEl = $("status");

let myServer,myId,localStream,audioCtx,pcMap=new Map(),audioEls=new Map();

// --- Connect button ---
$("connectBtn").onclick = async ()=>{
  myServer=$("server").value.trim();
  myId=$("pid").value.trim();
  if(!/^\d{4}$/.test(myServer))return alert("Enter 4-digit Server ID");
  if(!myId)return alert("Enter your UserId");

  joinCard.classList.add("hidden");
  await initAudio();
  loadPlayers();
  signalingInit();
};

// --- Mic + analyser ---
async function initAudio(){
  localStream=await navigator.mediaDevices.getUserMedia({audio:true});
  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  const src=audioCtx.createMediaStreamSource(localStream);
  const analyser=audioCtx.createAnalyser();
  analyser.fftSize=256;
  const data=new Uint8Array(analyser.frequencyBinCount);
  src.connect(analyser);
  const myBubble=ensureBubble(myId,"You");
  const loop=()=>{analyser.getByteFrequencyData(data);
    const avg=data.reduce((a,b)=>a+b,0)/data.length;
    if(avg>40)myBubble.classList.add("speaking");else myBubble.classList.remove("speaking");
    requestAnimationFrame(loop);}
  loop();
  statusEl.textContent="🎤 Mic Connected";
}

// --- Load Roblox players for this server ---
function loadPlayers(){
  db.ref("webvc/rooms/"+myServer+"/players").on("value",snap=>{
    const players=snap.val()||{};
    const ids=new Set(Object.keys(players));
    // remove gone
    document.querySelectorAll(".bubble").forEach(b=>{
      const id=b.id.replace("bubble_","");
      if(!ids.has(id)&&id!==myId)b.remove();
    });
    // update/add
    for(const [uid,p] of Object.entries(players)){
      ensureBubble(uid,p.name,p.avatar);
    }
  });
}

// --- Create/update bubble ---
function ensureBubble(id,name,avatar){
  let el=document.getElementById("bubble_"+id);
  if(!el){
    el=document.createElement("div");
    el.className="bubble";
    el.id="bubble_"+id;
    el.innerHTML=`<img><span></span>`;
    bubbles.appendChild(el);
  }
  el.querySelector("img").src=avatar||"";
  el.querySelector("span").textContent=name||id;
  return el;
}

// --- WebRTC signaling over Firebase ---
function signalingInit(){
  const sigRef=db.ref("webvc/signals/"+myServer);
  sigRef.on("child_added",async snap=>{
    const msg=snap.val();if(!msg)return;
    const{from,to,type,sdp,ice}=msg;
    if(to&&to!==myId)return;
    if(from===myId)return;

    if(type==="offer"){
      const pc=getPC(from);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const ans=await pc.createAnswer();
      await pc.setLocalDescription(ans);
      sendSig({from:myId,to:from,type:"answer",sdp:ans});
    }else if(type==="answer"){
      const pc=pcMap.get(from);if(pc)await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }else if(type==="ice"){
      const pc=pcMap.get(from);if(pc)await pc.addIceCandidate(new RTCIceCandidate(ice));
    }
  });
  sendSig({from:myId,type:"join"});
}

function getPC(peerId){
  if(pcMap.has(peerId))return pcMap.get(peerId);
  const pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  pcMap.set(peerId,pc);
  localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  pc.ontrack=e=>{
    const stream=e.streams[0];
    let audio=audioEls.get(peerId);
    if(!audio){
      audio=document.createElement("audio");
      audio.autoplay=true;audio.playsInline=true;
      document.body.appendChild(audio);
      audioEls.set(peerId,audio);
    }
    audio.srcObject=stream;
  };
  pc.onicecandidate=e=>{
    if(e.candidate)sendSig({from:myId,to:peerId,type:"ice",ice:e.candidate.toJSON()});
  };
  createOffer(peerId,pc);
  return pc;
}

async function createOffer(peerId,pc){
  const offer=await pc.createOffer({offerToReceiveAudio:true});
  await pc.setLocalDescription(offer);
  sendSig({from:myId,to:peerId,type:"offer",sdp:offer});
}

function sendSig(data){
  db.ref("webvc/signals/"+myServer).push(data);
}
