// ✅ Firebase setup
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

const serverInput = document.getElementById("server");
const pidInput = document.getElementById("pid");
const connectBtn = document.getElementById("connectBtn");
const status = document.getElementById("status");
const bubbleArea = document.getElementById("bubbles");

let myServer = null;
let myId = null;
let micStream = null;
let audioCtx, analyser, dataArray;

connectBtn.onclick = async () => {
  myServer = serverInput.value.trim();
  myId = pidInput.value.trim();
  if (!myServer || !myId) return alert("Enter server and player ID!");

  status.textContent = `Connected to server ${myServer}`;
  initVoice();
};

// Helper
const path = (...args) => args.join("/");

// 🎤 Mic setup
async function initVoice() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    status.textContent = "🎤 Mic Connected";

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    const src = audioCtx.createMediaStreamSource(micStream);
    src.connect(analyser);
    analyser.fftSize = 256;
    dataArray = new Uint8Array(analyser.frequencyBinCount);

    // Send speaking status to Firebase
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
  } catch (err) {
    status.textContent = "🎤 Mic Error: " + err.message;
  }
}

// 🟢 Listen to everyone in same server
function listenToPlayers() {
  const ref = db.ref(path("playerInfo", myServer));

  ref.on("value", snap => {
    const data = snap.val() || {};
    const ids = new Set(Object.keys(data));

    // Remove bubbles for players who left
    document.querySelectorAll(".bubble").forEach(b => {
      const id = b.id.replace("bubble_", "");
      if (!ids.has(id)) {
        b.classList.add("fade-out");
        setTimeout(() => b.remove(), 300);
      }
    });

    // Update / create bubbles
    Object.keys(data).forEach(pid => {
      const p = data[pid];
      if (!p) return;
      const el = createBubble(pid, p.name || pid, p.avatar || "", pid === myId);
      if (p.speaking) el.classList.add("speaking");
      else el.classList.remove("speaking");
    });
  });
}

// 🫧 Create player bubbles
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
  span.textContent = isMe ? name + " (You)" : name;
  div.appendChild(span);

  bubbleArea.appendChild(div);
  return div;
}
