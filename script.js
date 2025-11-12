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
const statusEl = $("status");
const bubbles = $("bubbles");
const path = (...p) => p.join("/");

/**********************
 * UI fields
 **********************/
const serverInput = $("server");
const pidInput = $("pid");
const nameInput = $("displayName");
const avatarInput = $("avatarUrl");
const connectBtn = $("connectBtn");

/**********************
 * State
 **********************/
let myServer = null, myId = null, myName = null, myAvatar = null;
let pcMap = new Map();         // peerId -> RTCPeerConnection
let audioEls = new Map();      // peerId -> <audio>
let bubbleEls = new Map();     // peerId -> bubble DIV
let analyserMap = new Map();   // peerId -> {analyser, data}
let localStream, audioCtx, localAnalyser, localData;

/**********************
 * Connect
 **********************/
connectBtn.onclick = async () => {
  myServer = (serverInput.value || "").trim();
  myId     = (pidInput.value || "").trim();
  myName   = (nameInput.value || "").trim();
  myAvatar = (avatarInput.value || "").trim();

  if (!/^\d{4}$/.test(myServer)) return alert("Enter a 4-digit Server Code");
  if (!myId) return alert("Enter your Player ID");

  // default avatar if none
  if (!myAvatar) myAvatar = "https://tr.rbxcdn.com/48b6bdbd9b7c13bb1d8aa16a47de05c0/150/150/AvatarHeadshot/Png";

  joinCard.classList.add("hidden");
  statusEl.textContent = "🎤 Requesting mic…";

  try {
    await initAudio();
    await announcePresence();
    watchPresence();
    signalingInit(); // WebRTC signaling over Firebase
  } catch (e) {
    alert("Mic or setup error: " + e.message);
    joinCard.classList.remove("hidden");
  }
};

/**********************
 * Audio + Local speaking anim
 **********************/
async function initAudio() {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  statusEl.textContent = "🎤 Mic Connected";

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(localStream);
  localAnalyser = audioCtx.createAnalyser();
  localAnalyser.fftSize = 512;
  localData = new Uint8Array(localAnalyser.frequencyBinCount);
  src.connect(localAnalyser);

  // create my bubble immediately
  const myBubble = ensureBubble(myId, myName || myId, myAvatar, true);

  // animate my speaking locally (no DB needed)
  const loop = () => {
    localAnalyser.getByteFrequencyData(localData);
    const avg = localData.reduce((a,b)=>a+b,0)/localData.length;
    if (avg > 45) myBubble.classList.add("speaking");
    else myBubble.classList.remove("speaking");
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/**********************
 * Presence & Profiles
 **********************/
async function announcePresence() {
  // store profile (used for bubbles)
  await db.ref(path("webvc","profiles",myServer,myId)).set({
    name: myName || myId,
    avatar: myAvatar
  });

  // presence with auto cleanup
  const presRef = db.ref(path("webvc","presence",myServer,myId));
  await presRef.set(firebase.database.ServerValue.TIMESTAMP);
  presRef.onDisconnect().remove();
}

function watchPresence() {
  const presPath = path("webvc","presence",myServer);

  // add/update peers
  db.ref(presPath).on("child_added", snap => {
    const peerId = snap.key;
    if (peerId === myId) return;
    // create offer only if myId is "lower" to avoid glare
    if (myId < peerId) createOfferTo(peerId);
  });

  // remove peers
  db.ref(presPath).on("child_removed", snap => {
    const peerId = snap.key;
    removePeer(peerId);
    removeBubble(peerId);
  });

  // load profiles to draw bubbles
  db.ref(path("webvc","profiles",myServer)).on("value", snap => {
    const dict = snap.val() || {};
    // remove bubbles that no longer have presence
    db.ref(presPath).once("value").then(presSnap => {
      const present = new Set(Object.keys(presSnap.val()||{}));
      for (const [id, el] of bubbleEls.entries()) {
        if (!present.has(id) && id !== myId) removeBubble(id);
      }
      Object.keys(dict).forEach(pid => {
        const p = dict[pid];
        ensureBubble(pid, p?.name || pid, p?.avatar, pid===myId);
      });
    });
  });
}

/**********************
 * Bubbles
 **********************/
function ensureBubble(id, name, avatar, isMe=false) {
  if (bubbleEls.has(id)) {
    // update label/avatar if changed
    const el = bubbleEls.get(id);
    el.querySelector("img").src = avatar || el.querySelector("img").src;
    el.querySelector("span").textContent = isMe ? `${name} (You)` : name;
    return el;
  }
  const el = document.createElement("div");
  el.className = "bubble" + (isMe ? " me":"");
  el.id = "bubble_"+id;
  el.innerHTML = `<img alt=""><span></span>`;
  el.querySelector("img").src = avatar || "";
  el.querySelector("span").textContent = isMe ? `${name} (You)` : name;
  bubbles.appendChild(el);
  bubbleEls.set(id, el);
  return el;
}

function removeBubble(id) {
  const el = bubbleEls.get(id);
  if (!el) return;
  el.classList.add("fade-out");
  setTimeout(()=>{ el.remove(); bubbleEls.delete(id); }, 250);
}

/**********************
 * WebRTC (Firebase signaling)
 **********************/
function signalingRef() { return db.ref(path("webvc","signals",myServer)); }

function signalingInit() {
  // incoming signaling
  signalingRef().on("child_added", async snap => {
    const msg = snap.val(); if (!msg) return;
    const { from, to, type } = msg;
    if (to && to !== myId) return;     // not for me
    if (from === myId) return;         // ignore own

    if (type === "offer") {
      const pc = getOrCreatePC(from);
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ from: myId, to: from, type: "answer", sdp: answer });
    } else if (type === "answer") {
      const pc = pcMap.get(from); if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } else if (type === "ice") {
      const pc = pcMap.get(from); if (!pc) return;
      try { await pc.addIceCandidate(new RTCIceCandidate(msg.ice)); } catch {}
    }
  });

  // announce join (helps late peers start offers)
  sendSignal({ from: myId, type: "join" });
}

function sendSignal(payload) {
  signalingRef().push(payload);
}

async function createOfferTo(peerId) {
  const pc = getOrCreatePC(peerId);
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  sendSignal({ from: myId, to: peerId, type: "offer", sdp: offer });
}

function getOrCreatePC(peerId) {
  if (pcMap.has(peerId)) return pcMap.get(peerId);

  const pc = new RTCPeerConnection({ iceServers: [{urls:"stun:stun.l.google.com:19302"}] });
  pcMap.set(peerId, pc);

  // add my mic
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // incoming audio
  pc.ontrack = (ev) => {
    const stream = ev.streams[0];
    let audio = audioEls.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true; audio.playsInline = true;
      document.body.appendChild(audio);
      audioEls.set(peerId, audio);

      // analyser for remote "speaking" anim
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      const data = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);

      analyserMap.set(peerId, { analyser, data });

      // bubble anim loop for this peer
      const el = ensureBubble(peerId, "", "", false);
      const tick = () => {
        if (!analyserMap.has(peerId)) return;
        const ref = analyserMap.get(peerId);
        ref.analyser.getByteFrequencyData(ref.data);
        const avg = ref.data.reduce((a,b)=>a+b,0)/ref.data.length;
        if (avg > 40) el.classList.add("speaking"); else el.classList.remove("speaking");
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    audio.srcObject = stream;
  };

  // ICE
  pc.onicecandidate = (ev) => {
    if (ev.candidate) sendSignal({ from: myId, to: peerId, type: "ice", ice: ev.candidate.toJSON() });
  };

  // ensure we have their name/avatar applied (when profile arrives)
  db.ref(path("webvc","profiles",myServer,peerId)).once("value").then(s=>{
    const p=s.val()||{};
    ensureBubble(peerId, p.name||peerId, p.avatar, false);
  });

  return pc;
}

function removePeer(peerId) {
  if (pcMap.has(peerId)) {
    try { pcMap.get(peerId).close(); } catch {}
    pcMap.delete(peerId);
  }
  if (audioEls.has(peerId)) {
    const el = audioEls.get(peerId);
    el.srcObject = null; el.remove();
    audioEls.delete(peerId);
  }
  analyserMap.delete(peerId);
}

/**********************
 * Cleanup on unload
 **********************/
window.addEventListener("beforeunload", () => {
  db.ref(path("webvc","presence",myServer,myId)).remove();
  // (signals auto-expire over time; presence removal clears UI for others)
});
