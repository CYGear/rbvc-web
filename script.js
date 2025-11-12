// --- Firebase Setup ---
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

// --- Elements ---
const connectBtn = document.getElementById("connectBtn");
const statusEl = document.getElementById("status");
const micStatusEl = document.getElementById("micStatus");
const bubbleArea = document.getElementById("bubbleArea");

let myServer, myId, myStream, analyser, dataArray, audioCtx;

connectBtn.onclick = async () => {
  myServer = document.getElementById("serverId").value.trim();
  myId = document.getElementById("playerId").value.trim();
  if (myServer.length !== 4 || myId.length < 5) {
    statusEl.innerText = "⚠️ Invalid IDs";
    return;
  }

  statusEl.innerText = "Connecting...";

  // 🎤 Ask for microphone access
  try {
    myStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStatusEl.innerText = "🎤 Mic Connected";
  } catch (e) {
    micStatusEl.innerText = "❌ Mic access denied";
    return;
  }

  // 🎚 Setup analyser for voice level detection
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(myStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  dataArray = new Uint8Array(analyser.frequencyBinCount);

  statusEl.innerText = "Connected to server " + myServer;

  // 🧠 Listen for users and positions
  const usersRef = db.ref("users/" + myServer);
  usersRef.on("value", (snap) => renderBubbles(snap.val() || {}));

  requestAnimationFrame(updateSpeakingVisual);
};

// --- Render bubbles with avatar + name ---
function renderBubbles(users) {
  bubbleArea.innerHTML = "";
  for (const id in users) {
    const u = users[id];
    const div = document.createElement("div");
    div.className = "bubble";
    div.id = "bubble_" + id;
    div.innerHTML = `
      <img src="${u.avatar || ''}" alt="">
      <span>${u.name || id}</span>
    `;
    bubbleArea.appendChild(div);
  }
}

// --- Animate mic volume pulse ---
function updateSpeakingVisual() {
  if (!analyser) return;
  analyser.getByteFrequencyData(dataArray);
  const avg = dataArray.reduce((a,b)=>a+b,0) / dataArray.length;
  const scale = 1 + Math.min(avg / 120, 0.6); // bubble grows when speaking
  const myBubble = document.getElementById("bubble_" + myId);
  if (myBubble) myBubble.style.transform = `scale(${scale})`;
  requestAnimationFrame(updateSpeakingVisual);
}
