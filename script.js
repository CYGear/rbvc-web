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

/**********************
 * DOM helpers + state
 **********************/
const $ = id => document.getElementById(id);
const joinCard = $("joinCard");
const serverInput = $("server");
const pidInput = $("pid");
const connectBtn = $("connectBtn");
const statusEl = $("status");
const bubbles = $("bubbles");
const logEl = $("log");
const path = (...p) => p.join("/");

let myServer = null, myId = null;
let localStream = null, audioCtx = null;
let pcMap = new Map();      // peerId -> RTCPeerConnection
let audioEls = new Map();   // peerId -> <audio>
let bubbleEls = new Map();  // peerId -> bubble DIV
let roomJoinTime = Date.now();

/**********************
 * Logging
 **********************/
function log(...args) {
  const s = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  console.log(s);
  if (logEl) {
    logEl.textContent += s + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }
}

window.addEventListener("DOMContentLoaded", () => log("✅ DOM loaded"));
navigator.mediaDevices.getUserMedia({audio:true})
  .then(()=>log("🎤 Mic permission OK (precheck)"))
  .catch(e=>log("❌ Mic precheck error:", e.message));

/**********************
 * Connect UI
 **********************/
connectBtn.onclick = async () => {
  myServer = (serverInput.value || "").trim();
  myId     = (pidInput.value || "").trim();
  if (!/^\d{4}$/.test(myServer)) return alert("Enter a 4-digit Server Code");
  if (!myId) return alert("Enter your UserId (from Roblox label)");

  joinCard.classList.add("hidden");
  roomJoinTime = Date.now();

  try {
    await initMic();
    await drawRobloxPlayers();
    await enterPresence();
    initSignaling();
  } catch (e) {
    log("❌ Setup error:", e.message);
    alert("Setup error: " + e.message);
    joinCard.classList.remove("hidden");
  }
};

/**********************
 * Mic + local analyser anim
 **********************/
async function initMic() {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(localStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  const data = new Uint8Array(analyser.frequencyBinCount);
  src.connect(analyser);

  const me = ensureBubble(myId, "You", null, true);

  const loop = () => {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a,b)=>a+b,0)/data.length;
    if (avg > 42) me.classList.add("speaking"); else me.classList.remove("speaking");
    requestAnimationFrame(loop);
  };
  loop();

  statusEl.textContent = "🎤 Mic Connected";
  log("🎤 Mic Connected");

  document.addEventListener("visibilitychange", () => {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  });
}

/**********************
 * Draw Roblox players (names/avatars)
 **********************/
async function drawRobloxPlayers() {
  const ref = db.ref(path("webvc","rooms",myServer,"players"));
  ref.on("value", snap => {
    const players = snap.val() || {};
    const ids = new Set(Object.keys(players));
    // remove old
    for (const [id, el] of bubbleEls.entries()) {
      if (id !== myId && !ids.has(id)) removeBubble(id);
    }
    // add/update
    Object.entries(players).forEach(([uid, p]) => {
      ensureBubble(uid, p?.name || uid, p?.avatar || null, uid === myId);
    });
  });
}

/**********************
 * Presence (website peers)
 **********************/
async function enterPresence() {
  const presRef = db.ref(path("webvc","presence",myServer,myId));
  await presRef.set(firebase.database.ServerValue.TIMESTAMP);
  presRef.onDisconnect().remove();
  log("✅ Presence set for", myId);

  const roomPres = db.ref(path("webvc","presence",myServer));
  roomPres.on("child_added", snap => {
    const peerId = snap.key;
    if (!peerId || peerId === myId) return;
    if (myId < peerId) {
      log("→ Will offer to", peerId);
      setTimeout(() => getOrCreatePC(peerId, true), 350);
    }
  });
  roomPres.on("child_removed", snap => {
    const peerId = snap.key;
    log("✖ Peer left:", peerId);
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
    el.id = "bubble_" + id;
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
 * WebRTC signaling (Firebase)
 **********************/
function signalsRef() { return db.ref(path("webvc","signals",myServer)); }

function initSignaling() {
  // prune old signals (older than 2 minutes) so we don't process stale
  const cutoff = Date.now() - 2*60*1000;
  signalsRef().once("value").then(s => {
    const all = s.val() || {};
    Object.entries(all).forEach(([k, msg]) => {
      if (!msg || typeof msg.ts !== "number") return;
      if (msg.ts < cutoff) signalsRef().child(k).remove();
    });
  });

  signalsRef().on("child_added", async snap => {
    const msg = snap.val(); if (!msg) return;
    const { from, to, type, sdp, ice, ts } = msg;
    if (to && to !== myId) return;          // not for me
    if (from === myId) return;              // ignore own
    if (ts && ts < roomJoinTime - 10000) {  // ignore stale before I joined
      log("⏩ Ignoring stale signal from", from, "type", type);
      return;
    }

    try {
      if (type === "offer") {
        log("⬇ offer from", from);
        const pc = getOrCreatePC(from, false);
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        sendSig({ from: myId, to: from, type: "answer", sdp: ans });
      } else if (type === "answer") {
        log("⬇ answer from", from);
        const pc = pcMap.get(from);
        if (pc && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        }
      } else if (type === "ice") {
        const pc = pcMap.get(from);
        if (pc) {
          await pc.addIceCandidate(new RTCIceCandidate(ice));
        }
      } else if (type === "join") {
        // no-op; presence handler will trigger offers
      }
    } catch (e) {
      log("⚠ signaling error:", e.message);
    }
  });

  sendSig({ from: myId, type: "join" });
  log("📡 Signaling started");
}

function sendSig(payload) {
  payload.ts = Date.now();
  signalsRef().push(payload);
}

function getOrCreatePC(peerId, initiateOffer) {
  if (pcMap.has(peerId)) return pcMap.get(peerId);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  pcMap.set(peerId, pc);

  // my mic
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // incoming audio
  pc.ontrack = e => {
    const stream = e.streams[0];
    let audio = audioEls.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = false;
      document.body.appendChild(audio);
      audioEls.set(peerId, audio);
    }
    audio.srcObject = stream;
    audio.play().catch(err => log("🔇 Autoplay blocked (click page):", err.message));
    log("🎧 ontrack from", peerId, "tracks:", stream.getTracks().map(t=>t.kind).join(","));
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      sendSig({ from: myId, to: peerId, type: "ice", ice: e.candidate.toJSON() });
    }
  };

  // show a bubble ASAP with Roblox info if present
  db.ref(path("webvc","rooms",myServer,"players",peerId)).once("value").then(s=>{
    const p = s.val();
    ensureBubble(peerId, (p && p.name) || peerId, p && p.avatar);
  });

  if (initiateOffer) {
    setTimeout(async () => {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        sendSig({ from: myId, to: peerId, type: "offer", sdp: offer });
        log("⬆ offer to", peerId);
      } catch (e) {
        log("⚠ offer error:", e.message);
      }
    }, 500);
  }

  return pc;
}

function tearDownPeer(peerId) {
  if (pcMap.has(peerId)) {
    try { pcMap.get(peerId).close(); } catch {}
    pcMap.delete(peerId);
  }
  const a = audioEls.get(peerId);
  if (a) { a.srcObject = null; a.remove(); audioEls.delete(peerId); }
}

/**********************
 * Cleanup on unload
 **********************/
window.addEventListener("beforeunload", () => {
  db.ref(path("webvc","presence",myServer,myId)).remove();
});
