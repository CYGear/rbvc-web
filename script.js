// ✅ Firebase setup
const firebaseConfig = {
  apiKey: "AIzaSyDoYmkPcR741Emh6PYIcUZQs745t8YhZXg",
  authDomain: "rbvc-cee15.firebaseapp.com",
  databaseURL: "https://rbvc-cee15-default-rtdb.firebaseio.com",
  projectId: "rbvc-cee15",
  storageBucket: "rbvc-cee15.firebasestorage.app",
  messagingSenderId: "290377633193",
  appId: "1:290377633193:web:ec54560fa4ca6294e308b8"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// UI Elements
const serverInput = document.getElementById("server");
const pidInput = document.getElementById("pid");
const connectBtn = document.getElementById("connectBtn");
const joinCard = document.getElementById("joinCard");
const status = document.getElementById("status");
const bubbleArea = document.getElementById("bubbles");

let myServer = null, myId = null;
let localStream, audioCtx, analyser, dataArray;

// WebRTC state
let peers = {}; // {peerId: RTCPeerConnection}
let iceCandidates = {}; // store ICE for delayed setup

// Utility
const path = (...args) => args.join("/");

connectBtn.onclick = async () => {
  myServer = serverInput.value.trim();
  myId = pidInput.value.trim();
  if (!myServer || !myId) return alert("Enter both fields!");

  joinCard.style.display = "none";
  status.textContent = "🎤 Connecting mic...";
  initVoice();
};

async function initVoice() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    status.textContent = "🎤 Mic Connected";

    // start analyzer for bubbles
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    const src = audioCtx.createMediaStreamSource(localStream);
    src.connect(analyser);
    analyser.fftSize = 256;
    dataArray = new Uint8Array(analyser.frequencyBinCount);

    // Periodic mic loudness → Firebase
    setInterval(() => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a,b)=>a+b,0)/dataArray.length;
      const speaking = avg > 40;
      db.ref(path("playerInfo", myServer, myId)).update({
        speaking,
        lastActive: Date.now()
      });
    }, 250);

    listenToPlayers();
    setupSignaling();
  } catch (e) {
    status.textContent = "Mic Error: " + e.message;
  }
}

// 🔁 Listen for player list + speaking updates
function listenToPlayers() {
  const ref = db.ref(path("playerInfo", myServer));

  ref.on("value", snap => {
    const data = snap.val() || {};
    const ids = new Set(Object.keys(data));

    // Remove gone players
    document.querySelectorAll(".bubble").forEach(b => {
      const id = b.id.replace("bubble_", "");
      if (!ids.has(id)) {
        b.classList.add("fade-out");
        setTimeout(() => b.remove(), 300);
      }
    });

    // Create / update bubbles
    Object.keys(data).forEach(pid => {
      const p = data[pid];
      if (!p) return;
      const el = createBubble(pid, p.name || pid, p.avatar || "", pid === myId);
      if (p.speaking) el.classList.add("speaking");
      else el.classList.remove("speaking");
    });
  });
}

// 🫧 Create player bubble
function createBubble(id, name, avatar, isMe) {
  let existing = document.getElementById("bubble_" + id);
  if (existing) return existing;

  const div = document.createElement("div");
  div.className = "bubble";
  div.id = "bubble_" + id;

  const img = document.createElement("img");
  img.src = avatar || "https://tr.rbxcdn.com/48b6bdbd9b7c13bb1d8aa16a47de05c0/150/150/AvatarHeadshot/Png";
  div.appendChild(img);

  const span = document.createElement("span");
  span.textContent = isMe ? `${name} (You)` : name;
  div.appendChild(span);

  bubbleArea.appendChild(div);
  return div;
}

// 🎧 WebRTC Peer Voice Setup
function setupSignaling() {
  const signalRef = db.ref(path("signals", myServer));

  // listen for signals
  signalRef.on("child_added", async snap => {
    const { from, type, sdp, ice } = snap.val();
    if (from === myId) return; // ignore self

    if (type === "offer") {
      const pc = createPeer(from);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      db.ref(path("signals", myServer)).push({ from: myId, to: from, type: "answer", sdp: answer });
    } else if (type === "answer" && peers[from]) {
      await peers[from].setRemoteDescription(new RTCSessionDescription(sdp));
    } else if (type === "ice" && peers[from]) {
      peers[from].addIceCandidate(new RTCIceCandidate(ice));
    }
  });

  // announce self
  setTimeout(() => {
    db.ref(path("signals", myServer)).push({ from: myId, type: "join" });
    createOffers();
  }, 1000);
}

function createPeer(peerId) {
  const pc = new RTCPeerConnection();
  peers[peerId] = pc;
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = e => {
    const audio = document.createElement("audio");
    audio.srcObject = e.streams[0];
    audio.autoplay = true;
    document.body.appendChild(audio);
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      db.ref(path("signals", myServer)).push({
        from: myId,
        to: peerId,
        type: "ice",
        ice: e.candidate
      });
    }
  };

  return pc;
}

async function createOffers() {
  const playersRef = db.ref(path("playerInfo", myServer));
  const snapshot = await playersRef.once("value");
  const players = snapshot.val() || {};
  for (const pid of Object.keys(players)) {
    if (pid === myId) continue;
    const pc = createPeer(pid);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    db.ref(path("signals", myServer)).push({ from: myId, to: pid, type: "offer", sdp: offer });
  }
}
