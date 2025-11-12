/***************
 * Firebase init
 ***************/
const firebaseConfig = {
  apiKey: "AIzaSyDoYmkPcR741Emh6PYIcUZQs745t8YhZXg",
  authDomain: "rbvc-cee15.firebaseapp.com",
  databaseURL: "https://rbvc-cee15-default-rtdb.firebaseio.com",
  projectId: "rbvc-cee15",
  storageBucket: "rbvc-cee15.firebasestorage.app",
  messagingSenderId: "290377633193",
  appId: "1:290377633193:web:ec54560fa4ca6294e308b8",
  measurementId: "G-7QMFV4PRHC"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

/***************
 * DOM handles
 ***************/
const overlay   = document.getElementById("overlay");
const connectBtn= document.getElementById("connectBtn");
const bubbleArea= document.getElementById("bubbleArea");
const micStatus = document.getElementById("micStatus");

/***************
 * Global state
 ***************/
let myId = null;
let myServer = null;
let myStream = null;
let myAnalyser, myAnalyserData;
let audioCtx;
let positionsCache = {}; // playerInfo merged data
let peers = new Map();

const rtcConfig = { iceServers: [{urls:"stun:stun.l.google.com:19302"}] };

function path(...parts){ return parts.join("/"); }

/***************
 * Bubble creator
 ***************/
function createBubble(id, name, avatar, isMe=false){
  let el = document.getElementById("bubble_"+id);
  if(!el){
    el = document.createElement("div");
    el.className = "bubble"+(isMe?" me":"");
    el.id = "bubble_"+id;
    el.innerHTML = `<img src="${avatar||''}" alt=""><span>${name||id}</span>`;
    bubbleArea.appendChild(el);
  } else {
    el.querySelector("img").src = avatar||"";
    el.querySelector("span").textContent = name||id;
  }
  return el;
}

/***************
 * Helper: distance volume
 ***************/
function dist(a,b){
  if(!a||!b) return 999;
  const dx=a.x-b.x, dy=a.y-b.y, dz=a.z-b.z;
  return Math.sqrt(dx*dx+dy*dy+dz*dz);
}
function volumeForDist(d){ return Math.max(0, 1 - d/100); }

/***************
 * WebRTC core
 ***************/
async function ensurePeer(peerId){
  if(peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection(rtcConfig);
  myStream.getTracks().forEach(t=>pc.addTrack(t,myStream));

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = 0;

  const audioEl = new Audio();
  audioEl.autoplay = true; audioEl.playsInline = true;

  let analyser=null, analyserData=null;

  pc.ontrack = ev=>{
    const remoteStream = ev.streams[0];
    const src = audioCtx.createMediaStreamSource(remoteStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyserData = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    src.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    audioEl.srcObject = remoteStream;
  };

  pc.onicecandidate = ev=>{
    if(ev.candidate){
      db.ref(path("vc", myServer, "ice", peerId, myId)).push(ev.candidate.toJSON());
    }
  };

  db.ref(path("vc", myServer, "ice", myId, peerId))
    .on("child_added", s=>{
      const c=s.val();
      if(c) pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
    });

  const bubble=createBubble(peerId,"Loading...","",false);
  const rec={pc,gain:gainNode,analyser,analyserData,bubble};
  peers.set(peerId,rec);
  return rec;
}

async function callPeer(peerId){
  const rec=await ensurePeer(peerId);
  const {pc}=rec;
  const offer=await pc.createOffer({offerToReceiveAudio:true});
  await pc.setLocalDescription(offer);
  await db.ref(path("vc",myServer,"offers",peerId,myId)).set(offer);
  db.ref(path("vc",myServer,"answers",myId,peerId)).on("value",async snap=>{
    const ans=snap.val();
    if(ans && !pc.currentRemoteDescription){
      await pc.setRemoteDescription(new RTCSessionDescription(ans));
    }
  });
}

async function answerPeer(peerId,offer){
  const rec=await ensurePeer(peerId);
  const {pc}=rec;
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer=await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await db.ref(path("vc",myServer,"answers",peerId,myId)).set(answer);
}

/***************
 * UI + animation
 ***************/
function startAnimation(){
  const loop=()=>{
    if(myAnalyser){
      myAnalyser.getByteFrequencyData(myAnalyserData);
      const avg=myAnalyserData.reduce((a,b)=>a+b,0)/myAnalyserData.length;
      const scale=1+Math.min(avg/120,0.7);
      const el=document.getElementById("bubble_"+myId);
      if(el) el.style.transform=`scale(${scale})`;
    }
    peers.forEach(rec=>{
      if(rec.analyser && rec.bubble){
        rec.analyser.getByteFrequencyData(rec.analyserData);
        const avg=rec.analyserData.reduce((a,b)=>a+b,0)/rec.analyserData.length;
        const scale=1+Math.min(avg/130,0.6);
        rec.bubble.style.transform=`scale(${scale})`;
      }
    });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function startDistanceLoop(){
  setInterval(()=>{
    const me=positionsCache[myId];
    peers.forEach((rec,id)=>{
      const p=positionsCache[id];
      const d=dist(me,p);
      const vol=volumeForDist(d);
      if(rec.gain) rec.gain.gain.value=vol;
    });
  },150);
}

/***************
 * Connect flow
 ***************/
connectBtn.onclick = async ()=>{
  myServer=document.getElementById("serverId").value.trim();
  myId=document.getElementById("playerId").value.trim();
  if(myServer.length!==4 || myId.length<5){alert("Enter valid IDs");return;}

  overlay.style.display="none";

  // mic
  try{
    myStream=await navigator.mediaDevices.getUserMedia({audio:true});
    micStatus.textContent="🎤 Mic Connected";
  }catch{micStatus.textContent="❌ Mic blocked";return;}

  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  const src=audioCtx.createMediaStreamSource(myStream);
  myAnalyser=audioCtx.createAnalyser();
  myAnalyser.fftSize=512;
  myAnalyserData=new Uint8Array(myAnalyser.frequencyBinCount);
  src.connect(myAnalyser);

  createBubble(myId,"You","",true);

  const presRef=db.ref(path("vc",myServer,"presence",myId));
  presRef.set(firebase.database.ServerValue.TIMESTAMP);
  presRef.onDisconnect().remove();

  // listen to combined playerInfo
  db.ref(path("playerInfo",myServer)).on("value",snap=>{
    const data=snap.val()||{};
    positionsCache=data;
    Object.keys(data).forEach(pid=>{
      const p=data[pid];
      createBubble(pid,p.name||pid,p.avatar||"",pid===myId);
    });
  });

  // presence → detect peers and start WebRTC
  db.ref(path("vc",myServer,"presence")).on("value",snap=>{
    const all=snap.val()||{};
    const ids=Object.keys(all).filter(i=>i!==myId);
    ids.forEach(pid=>{
      if(myId<pid) callPeer(pid);
      else db.ref(path("vc",myServer,"offers",myId,pid))
        .on("value",s=>{
          const offer=s.val();
          if(offer) answerPeer(pid,offer);
        });
    });
  });

  startAnimation();
  startDistanceLoop();
};

/***************
 * cleanup
 ***************/
window.addEventListener("beforeunload",()=>{
  if(myServer&&myId){
    db.ref(path("vc",myServer,"presence",myId)).remove();
    db.ref(path("vc",myServer,"offers",myId)).remove();
    db.ref(path("vc",myServer,"answers",myId)).remove();
    db.ref(path("vc",myServer,"ice",myId)).remove();
  }
});
