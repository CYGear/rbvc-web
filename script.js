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
 * DOM
 ***************/
const overlay   = document.getElementById("overlay");
const connectBtn= document.getElementById("connectBtn");
const bubbleArea= document.getElementById("bubbleArea");
const micStatus = document.getElementById("micStatus");

/***************
 * State
 ***************/
let myId = null;
let myServer = null;
let myStream = null;
let myPos = {x:0,y:0,z:0};
let audioCtx, myAnalyser, myAnalyserData;

const peers = new Map(); // peerId -> {pc, audio, stream, gain, analyser, analyserData, bubble}
let usersCache = {};     // playerId -> {name, avatar}
let positionsCache = {}; // playerId -> {x,y,z}

/***************
 * Helpers
 ***************/
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function createBubble(playerId, name, avatar, isMe=false){
  let el = document.getElementById("bubble_"+playerId);
  if(!el){
    el = document.createElement("div");
    el.className = "bubble"+(isMe?" me":"");
    el.id = "bubble_"+playerId;
    el.innerHTML = `<img src="${avatar||''}" alt=""><span>${name||playerId}</span>`;
    bubbleArea.appendChild(el);
  }else{
    el.querySelector("img").src = avatar || "";
    el.querySelector("span").textContent = name || playerId;
  }
  return el;
}

function distance(a,b){
  if(!a||!b) return 99999;
  const dx=a.x-b.x, dy=a.y-b.y, dz=a.z-b.z;
  return Math.sqrt(dx*dx+dy*dy+dz*dz);
}

function volumeForDistance(d){
  // 0..100 studs → 1..0 volume (clamped)
  const v = Math.max(0, 1 - (d/100));
  return v;
}

/***************
 * WebRTC using Firebase as signaling
 ***************/
const rtcConfig = {
  iceServers: [{urls:"stun:stun.l.google.com:19302"}]
};

function firebasePath(...parts){
  return parts.join("/");
}

async function ensurePeer(peerId){
  if(peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection(rtcConfig);
  myStream.getTracks().forEach(t => pc.addTrack(t, myStream));

  // Per-peer audio path: create Gain node (for distance volume)
  if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();

  const destStream = new MediaStream();
  const audioEl = new Audio();
  audioEl.autoplay = true; audioEl.playsInline = true;

  // audio graph: element <- destination <- gain <- source(stream)
  const gain = audioCtx.createGain();
  gain.gain.value = 0; // start muted until we compute distance

  let analyser=null, analyserData=null;

  pc.ontrack = (ev)=>{
    const remoteStream = ev.streams[0];
    // route through WebAudio so we can set volume by distance
    const src = audioCtx.createMediaStreamSource(remoteStream);
    src.connect(gain);
    gain.connect(audioCtx.destination);

    // analyser for bubble pulse
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyserData = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);

    // we still attach to <audio> to keep autoplay policies happy on some browsers
    audioEl.srcObject = remoteStream;
  };

  pc.onicecandidate = async (ev)=>{
    if(ev.candidate){
      const ref = db.ref(firebasePath("vc", myServer, "ice", peerId, myId)).push();
      ref.set(ev.candidate.toJSON());
    }
  };

  // Listen for remote ICE from peer
  db.ref(firebasePath("vc", myServer, "ice", myId, peerId))
    .on("child_added", async snap=>{
      const cand = snap.val();
      if(cand) {
        try{ await pc.addIceCandidate(new RTCIceCandidate(cand)); }catch{}
      }
    });

  const bubble = createBubble(
    peerId,
    usersCache[peerId]?.name || peerId,
    usersCache[peerId]?.avatar || "",
    false
  );

  const rec = {pc, audio:audioEl, gain, analyser, analyserData, bubble};
  peers.set(peerId, rec);
  return rec;
}

async function callPeer(peerId){
  const rec = await ensurePeer(peerId);
  const {pc} = rec;

  const offer = await pc.createOffer({offerToReceiveAudio:true});
  await pc.setLocalDescription(offer);

  // write offer to peer
  await db.ref(firebasePath("vc", myServer, "offers", peerId, myId)).set(offer);

  // wait for answer
  db.ref(firebasePath("vc", myServer, "answers", myId, peerId))
    .on("value", async snap=>{
      const ans = snap.val();
      if(ans && (!pc.currentRemoteDescription)){
        try { await pc.setRemoteDescription(new RTCSessionDescription(ans)); }
        catch(e){}
      }
    });
}

async function answerPeer(fromId, offer){
  const rec = await ensurePeer(fromId);
  const {pc} = rec;

  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  await db.ref(firebasePath("vc", myServer, "answers", fromId, myId)).set(answer);
}

/***************
 * Live UI + volume loops
 ***************/
function startBubbleAnimation(){
  // animate my bubble with mic loudness
  const loop = ()=>{
    // my mic level
    if(myAnalyser){
      myAnalyser.getByteFrequencyData(myAnalyserData);
      const avg = myAnalyserData.reduce((a,b)=>a+b,0) / myAnalyserData.length;
      const scale = 1 + Math.min(avg/120, 0.7);
      const me = document.getElementById("bubble_"+myId);
      if(me) me.style.transform = `scale(${scale})`;
    }
    // peers pulse based on their analyser
    peers.forEach(rec=>{
      if(rec.analyser && rec.bubble){
        rec.analyser.getByteFrequencyData(rec.analyserData);
        const avg = rec.analyserData.reduce((a,b)=>a+b,0)/rec.analyserData.length;
        const scale = 1 + Math.min(avg/120, 0.6);
        rec.bubble.style.transform = `scale(${scale})`;
      }
    });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function startDistanceVolumeLoop(){
  setInterval(()=>{
    const myP = positionsCache[myId] || myPos;
    peers.forEach((rec, pid)=>{
      const theirP = positionsCache[pid];
      const d = distance(myP, theirP);
      const vol = volumeForDistance(d); // 0..1
      if(rec.gain) rec.gain.gain.value = vol;
    });
  }, 120);
}

/***************
 * Join flow
 ***************/
connectBtn.onclick = async ()=>{
  myServer = document.getElementById("serverId").value.trim();
  myId     = document.getElementById("playerId").value.trim();

  if(myServer.length!==4 || myId.length<5){
    alert("Enter valid Server/Player IDs.");
    return;
  }

  overlay.style.display = "none";

  // Mic
  try{
    myStream = await navigator.mediaDevices.getUserMedia({audio:true});
    micStatus.textContent = "🎤 Mic: Connected";
  }catch{
    micStatus.textContent = "❌ Mic blocked";
    return;
  }

  // My analyser for bubble pulse
  audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(myStream);
  myAnalyser = audioCtx.createAnalyser();
  myAnalyser.fftSize = 512;
  src.connect(myAnalyser);
  myAnalyserData = new Uint8Array(myAnalyser.frequencyBinCount);

  // Render ME bubble immediately using users entry (will update when usersCache loads)
  createBubble(myId, "You", "", true);

  // Presence + cleanup
  const presRef = db.ref(firebasePath("vc", myServer, "presence", myId));
  presRef.set(firebase.database.ServerValue.TIMESTAMP);
  presRef.onDisconnect().remove();

  // Listen for users info (names/avatars) to render bubbles
  db.ref(firebasePath("users", myServer)).on("value", snap=>{
    usersCache = snap.val() || {};
    // refresh bubbles for anyone we already know
    Object.keys(usersCache).forEach(pid=>{
      const u = usersCache[pid];
      createBubble(pid, u.name||pid, u.avatar||"", pid===myId);
    });
  });

  // Listen for positions to compute distance volume
  db.ref(firebasePath("positions", myServer)).on("value", snap=>{
    positionsCache = snap.val() || {};
    // keep my own cached pos if present
    if(positionsCache[myId]) myPos = positionsCache[myId];
  });

  // Discover peers via presence; use lexicographic rule to avoid double dialing:
  // the "smaller" id places the call.
  db.ref(firebasePath("vc", myServer, "presence"))
    .on("value", async snap=>{
      const present = snap.val() || {};
      const ids = Object.keys(present).filter(id=>id!==myId);

      // create bubbles for new folks
      ids.forEach(pid=>{
        const u = usersCache[pid] || {};
        createBubble(pid, u.name||pid, u.avatar||"");
      });

      for(const pid of ids){
        if(myId < pid){ // I initiate
          await callPeer(pid);
        }else{
          // I wait for an offer
          db.ref(firebasePath("vc", myServer, "offers", myId, pid))
            .on("value", async offerSnap=>{
              const offer = offerSnap.val();
              if(offer){
                await answerPeer(pid, offer);
              }
            });
        }
      }
    });

  // Start visual loops
  startBubbleAnimation();
  startDistanceVolumeLoop();
};

/***************
 * Cleanup on close
 ***************/
window.addEventListener("beforeunload", ()=>{
  if(myServer && myId){
    db.ref(firebasePath("vc", myServer, "presence", myId)).remove();
    db.ref(firebasePath("vc", myServer, "offers", myId)).remove();
    db.ref(firebasePath("vc", myServer, "answers", myId)).remove();
    db.ref(firebasePath("vc", myServer, "ice", myId)).remove();
  }
});

