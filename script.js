// ✅ Firebase setup
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

const serverInput = document.getElementById("server");
const pidInput = document.getElementById("pid");
const connectBtn = document.getElementById("connectBtn");
const joinCard = document.getElementById("joinCard");
const status = document.getElementById("status");
const bubbleArea = document.getElementById("bubbles");

let myServer = null;
let myId = null;

connectBtn.onclick = async () => {
  myServer = serverInput.value.trim();
  myId = pidInput.value.trim();
  if (!myServer || !myId) return alert("Enter server and player ID!");

  joinCard.classList.add("hidden");
  status.textContent = `Connected to server ${myServer}`;
  initVoice();
};

// Firebase helper
const path = (...args) => args.join("/");

// 🔊 Mic detection + speaking status
async function initVoice() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    status.textContent = "🎤 Mic Connected";

    // Create audio analyser
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    const src = audioCtx.createMediaStreamSource(stream);
    src.connect(analyser);
    analyser.fftSize = 256;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    // Regularly update speaking state + timestamp
    setInterval(() => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const speaking = avg > 40;
      db.ref(path("playerInfo", myServer, myId)).update({
        speaking,
        lastActive: Date.now(),
      });
    }, 250);

    // cleanup when tab closed
    window.addEventListener("beforeunload", () => {
      db.ref(path("playerInfo", myServer, myId)).remove();
    });

    listenToPlayers();
  } catch (err) {
    status.textContent = "🎤 Mic Error: " + err.message;
  }
}

// 🟢 Listen to playerInfo changes
function listenToPlayers() {
  const ref = db.ref(path("playerInfo", myServer));

  ref.on("value", (snap) => {
    const data = snap.val() || {};

    // Remove disconnected players
    const currentIds = new Set(Object.keys(data));
    document.querySelectorAll(".bubble").forEach((b) => {
      const id = b.id.replace("bubble_", "");
      if (!currentIds.has(id)) b.remove();
    });

    // Create / update each player bubble
    Object.keys(data).forEach((pid) => {
      const p = data[pid];
      if (p && typeof p === "object") {
        const el = createBubble(pid, p.name || pid, p.avatar || "", pid === myId);
        if (p.speaking) el.classList.add("speaking");
        else el.classList.remove("speaking");
      }
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
  img.src =
    avatar ||
    "https://tr.rbxcdn.com/48b6bdbd9b7c13bb1d8aa16a47de05c0/150/150/AvatarHeadshot/Png";
  div.appendChild(img);

  const span = document.createElement("span");
  span.textContent = isMe ? name + " (You)" : name;
  div.appendChild(span);

  bubbleArea.appendChild(div);
  return div;
}
