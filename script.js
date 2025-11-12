/**********************
 * Draw Roblox players (names/avatars)
 **********************/
async function drawRobloxPlayers() {
  const ref = db.ref(path("webvc", "rooms", myServer, "players"));
  ref.on("value", (snap) => {
    const players = snap.val() || {};
    const ids = new Set(Object.keys(players));

    // Remove old bubbles for players who left
    for (const [id, el] of bubbleEls.entries()) {
      if (id !== myId && !ids.has(id)) removeBubble(id);
    }

    // Add or update player bubbles
    Object.entries(players).forEach(([uid, p]) => {
      const avatarUrl = p?.avatar
        ? p.avatar.replace("width=150", "width=180")
        : `https://www.roblox.com/headshot-thumbnail/image?userId=${uid}&width=180&height=180&format=png`;

      ensureBubble(uid, p?.name || uid, avatarUrl, uid === myId);
    });
  });

  // 🔥 Listen for speaking states (so everyone sees bubbles glow)
  const speakRef = db.ref(path("webvc", "speak", myServer));
  speakRef.on("value", (snap) => {
    const data = snap.val() || {};
    for (const [uid, state] of Object.entries(data)) {
      const el = bubbleEls.get(uid);
      if (!el) continue;
      if (state === "on") el.classList.add("speaking");
      else el.classList.remove("speaking");
    }
  });
}

/**********************
 * Create / update bubbles
 **********************/
function ensureBubble(id, name, avatar, isMe = false) {
  let el = bubbleEls.get(id);
  if (!el) {
    el = document.createElement("div");
    el.className = "bubble" + (isMe ? " me" : "");
    el.id = "bubble_" + id;
    el.innerHTML = `<img alt="avatar" loading="lazy"><span></span>`;
    bubbles.appendChild(el);
    bubbleEls.set(id, el);

    // ✅ If it's you, start sending your speaking data
    if (isMe) startSpeakingMonitor(id);
  }

  const img = el.querySelector("img");
  const span = el.querySelector("span");

  // Apply avatar (with fallback if broken)
  img.src = avatar;
  img.onerror = () => {
    img.src = `https://www.roblox.com/headshot-thumbnail/image?userId=${id}&width=180&height=180&format=png`;
  };

  span.textContent = isMe ? `${name} (You)` : name;
  return el;
}

/**********************
 * Remove bubble when player leaves
 **********************/
function removeBubble(id) {
  const el = bubbleEls.get(id);
  if (!el) return;
  el.classList.add("fade-out");
  setTimeout(() => {
    el.remove();
    bubbleEls.delete(id);
  }, 250);
}

/**********************
 * Speaking state broadcast (for everyone)
 **********************/
function startSpeakingMonitor(myId) {
  if (!audioCtx) return;

  const src = audioCtx.createMediaStreamSource(localStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  const data = new Uint8Array(analyser.frequencyBinCount);
  src.connect(analyser);

  const ref = db.ref(path("webvc", "speak", myServer, myId));
  let lastState = "";

  const loop = () => {
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const state = avg > 42 ? "on" : "off";

    if (state !== lastState) {
      ref.set(state);
      lastState = state;
    }

    requestAnimationFrame(loop);
  };
  loop();
}
