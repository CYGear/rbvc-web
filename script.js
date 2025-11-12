/**********************
 * Firebase init
 **********************/
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
const serverInput = $("server");
const pidInput = $("pid");
const connectBtn = $("connectBtn");
const statusEl = $("status");
const bubbles = $("bubbles");

const path = (...p) => p.join("/");

/**********************
 * State
 **********************/
let myServer = null, myId = null;
let localStream = null, audioCtx = null;
let pcMap = new Map();      // peerId -> RTCPeerConnection
let audioEls = new Map();   // peerId -> <audio>
let bubbleEls = new Map();  // peerId -> bubble DIV

/**********************
 * UI Hook
 **********************/
connectBtn.onclick = async () => {
  myServer = (serverInput.value || "").trim();
  myId = (pidInput.value || "").trim();

  if (!/^\d{4}$/.test(myServer)) return alert("Enter a 4-digit Server Code");
  if (!myId) return alert("Enter your UserId shown in Roblox");

  // Hide join UI
  joinCard.classList.add("hidden");

  // Start mic + room
  try {
    await initMic();
    await showRobloxPlayers(); // bubbles from Roblox list
    await enterPresence();     // web presence for WebRTC
    initSignaling();           // start listening for offers/answers/ice
  } catch (e) {
    console.error(e);
    alert("Setup error: " + e.message);
    joinCard.classList.remove("hidden");
  }
};

/**********************
 * Mic (local analyser anim)
 **********************/
async function initMic() {
  // Must be HTTPS (GitHub Pages is OK)
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(localStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  const data = new Uint8Array(analyser.frequencyBinCount);
  src.connect(analyser);

  // Create my local bubble
  const me = ensureBubble(myId, "You", null, true);

  // Local speaking animation loop
  const loop = () => {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a,b)=>a+b,0)/data.length;
    if (avg > 42) me.classList.add("speaking");
    else me.classList.remove("speaking");
    requestAnimationFrame(loop);
  };
  loop();

  statusEl.textContent = "🎤 Mic Connected";

  // Resume context if tab regains focus
  document.addEventListener("visibilitychange", () => {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  });
}

/**********************
 * Draw Roblox players as bubbles
 **********************/
async function showRobloxPlayers() {
  const ref = db.ref(path("webvc","rooms",myServer,"players"));
  ref.on("value", snap => {
    const players = snap.val() || {};
    const online = new Set(Object.keys(players));

    // remove bubbles for players no longer listed (except me)
    for (const [pid, el] of bubbleEls.entries()) {
      if (pid !== myId && !online.has(pid)) removeBubble(pid);
    }

    // create/update bubbles for players
    Object.entries(players).forEach(([uid, p]) => {
      ensureBubble(uid, p?.name || uid, p?.avatar || null, uid === myId);
    });
  });
}

/**********************
 * Presence for website peers (WebRTC membership)
 **********************/
async function enterPresence() {
  const presRef = db.ref(path("webvc","presence",myServer,myId));
  await presRef.set(firebase.database.ServerValue.TIMESTAMP);
  presRef.onDisconnect().remove();

  // When others appear/disappear, connect/disconnect
  const roomPres = db.ref(path("webvc","presence",myServer));
  roomPres.on("child_added", snap => {
    const peerId = snap.key;
    if (!peerId || peerId === myId) return;
    // To avoid glare, initiate offer from lexicographically smaller ID
    if (myId < peerId) {
      // small delay to let their signaling listener attach
      setTimeout(() => getOrCreatePC(peerId, true), 350);
    }
  });
  roomPres.on("child_removed", snap => {
    const peerId = snap.key;
    tearDownPeer(peerId);
    removeBubble(peerId);
  });
}

/**********************
 * Bubbles
 **********************/
function ensureBubble(id, name, avatar, isMe=false) {
  let el = bubbleEls.get(id);
  if (!el) {
    el = document.createElement("div");
    el.className = "bubble" + (isMe ? " me" : "");
    el.id = "bubble_"+id;
    el.innerHTML = `<img alt=""><span></span>`;
    bubbles.appendChild(el);
    bubbleEls.set(id, el);
  }
  const img = el.querySelector("img");
  const span = el.querySelector("span");
  if (avatar) img.src = avatar;
  span.textContent = isMe ? `${name} (You)` : name;
  return el;
}

function removeBubble(id) {
  const el = bubbleEls.get(id);
  if (!el) return;
  el.classList.add("fade-out");
  setTimeout(() => { el.remove(); bubbleEls.delete(id); }, 220);
}

/**********************
 * WebRTC signaling (via Firebase)
 **********************/
function sigRef() { return db.ref(path("webvc","signals",myServer)); }

function initSignaling() {
  sigRef().on("child_added", async snap => {
    const msg = snap.val(); if (!msg) return;
    const { from, to, type, sdp, ice } = msg;
    // ignore messages not for me (when targeted)
    if (to && to !== myId) return;
    if (from === myId) return;

    try {
      if (type === "offer") {
        const pc = getOrCreatePC(from, false);
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSig({ from: myId, to: from, type: "answer", sdp: answer });
      } else if (type === "answer") {
        const pc = pcMap.get(from);
        if (pc && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        }
      } else if (type === "ice") {
        const pc = pcMap.get(from);
        if (pc) await pc.addIceCandidate(new RTCIceCandidate(ice));
      }
    } catch (e) {
      console.warn("Signaling error:", e);
    }
  });

  // announce presence to wake listeners
  sendSig({ from: myId, type: "join" });
}

function sendSig(payload) {
  sigRef().push(payload);
}

function getOrCreatePC(peerId, iInitiateOffer) {
  if (pcMap.has(peerId)) return pcMap.get(peerId);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  pcMap.set(peerId, pc);

  // add my mic
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // incoming audio
  pc.ontrack = e => {
    const stream = e.streams[0];
    let audio = audioEls.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      // try auto-play (Chrome policy)
      audio.muted = false;
      document.body.appendChild(audio);
      audioEls.set(peerId, audio);
    }
    audio.srcObject = stream;
    // ensure playback
    audio.play().catch(err => console.warn("Autoplay blocked:", err));
    console.log("🎧 Got audio track from:", peerId);
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      sendSig({ from: myId, to: peerId, type: "ice", ice: e.candidate.toJSON() });
    }
  };

  // initiate
  if (iInitiateOffer) {
    setTimeout(async () => {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        sendSig({ from: myId, to: peerId, type: "offer", sdp: offer });
      } catch (e) {
        console.warn("Offer error:", e);
      }
    }, 500); // small delay helps cross-attach
  }

  // ensure we render a bubble for this peer as soon as we see them
  db.ref(path("webvc","rooms",myServer,"players",peerId)).once("value").then(s=>{
    const p = s.val();
    ensureBubble(peerId, (p && p.name) || peerId, p && p.avatar);
  });

  return pc;
}

function tearDownPeer(peerId) {
  const pc = pcMap.get(peerId);
  if (pc) {
    try { pc.close(); } catch {}
    pcMap.delete(peerId);
  }
  const a = audioEls.get(peerId);
  if (a) {
    a.srcObject = null;
    a.remove();
    audioEls.delete(peerId);
  }
}

/**********************
 * Cleanup on unload
 **********************/
window.addEventListener("beforeunload", () => {
  db.ref(path("webvc","presence",myServer,myId)).remove();
});
