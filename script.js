// Firebase config from your project
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

// Initialize firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

let myId;
let serverId;
let peer;
let audioElements = {};

async function joinVC() {
    serverId = document.getElementById("serverId").value;
    myId = document.getElementById("playerId").value;

    // microphone permissions
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    peer = new SimplePeer({ initiator: true, trickle: false, stream });

    // Send your WebRTC signal to Firebase
    peer.on("signal", data => {
        db.ref(`signals/${serverId}/${myId}`).set(data);
    });

    // Listen for other peers' signals
    db.ref(`signals/${serverId}`).on("value", snapshot => {
        const signals = snapshot.val();
        if (!signals) return;

        for (let id in signals) {
            if (id !== myId) {
                peer.signal(signals[id]);
            }
        }
    });

    // When remote audio stream arrives
    peer.on("stream", remoteStream => {
        const audio = new Audio();
        audio.srcObject = remoteStream;
        audio.autoplay = true;
        audioElements["main"] = audio;
    });

    // Listen for position updates from Roblox
    db.ref(`positions/${serverId}`).on("value", snap => {
        updateVolumes(snap.val());
    });
}

// Update distances → set volume
function updateVolumes(pos) {
    if (!pos || !pos[myId]) return;

    const me = pos[myId];

    for (let id in pos) {
        if (id === myId) continue;

        const p = pos[id];

        const dx = me.x - p.x;
        const dy = me.y - p.y;
        const dz = me.z - p.z;

        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

        // volume decreases with distance
        const volume = Math.max(0, 1 - dist / 50);

        if (audioElements[id]) {
            audioElements[id].volume = volume;
        }
    }
}
