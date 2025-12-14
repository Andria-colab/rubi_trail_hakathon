console.log("🔥 FRONTEND SCRIPT LOADED");

// If you host frontend on the same backend, this auto-works.
// If you host frontend on Vercel, this still uses Render backend.
const API_BASE = "https://rubi-trail-hakathon.onrender.com";

let authToken = null;

function showLoading() {
  const el = document.getElementById("loading");
  if (el) el.classList.add("active");
}
function hideLoading() {
  const el = document.getElementById("loading");
  if (el) el.classList.remove("active");
}

function getAuthHeaders() {
  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + authToken,
  };
}

// ---------------- AUTH ----------------
// ✅ Real auth: Telegram injects initData when launched as a Mini App
async function initAuth() {
  try {
    const tg = window.Telegram?.WebApp;

    try { tg?.expand(); } catch (_) {}

    const initData = tg?.initData || "";
    const user = tg?.initDataUnsafe?.user || null;

    console.log("Telegram WebApp exists?", Boolean(tg));
    console.log("initData length:", initData.length);
    console.log("user:", user);

    if (!initData || !user?.id) {
      alert(
        "Telegram didn't provide login data.\n\n" +
        "Open using the bot's 'Open RubiTrail' button (Mini App), not a normal link."
      );
      return;
    }

    const payload = {
      initData,                         // for verification (best)
      telegram_id: String(user.id),     // for creating/finding user
      name: [user.first_name, user.last_name].filter(Boolean).join(" "),
    };

    const res = await fetch(`${API_BASE}/auth/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Auth error:", data);
      alert(data.error || "Telegram auth failed. Check backend logs.");
      return;
    }

    authToken = data.token;

    const balanceElement = document.querySelector(".coin-balance");
    if (balanceElement && data.user) {
      balanceElement.innerHTML = `${data.user.coins} <div class="coin-icon"></div>`;
    }
  } catch (err) {
    console.error("Auth failed:", err);
    alert("Could not connect to backend (auth).");
  }
}


// ---------------- CAMERA + SCAN ----------------
const videoElement = document.getElementById("camera-stream");
let localStream;
let scanning = false;

const qrCanvas = document.createElement("canvas");
const qrCtx = qrCanvas.getContext("2d");

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    localStream = stream;
    if (videoElement) videoElement.srcObject = stream;

    const scanText = document.querySelector(".scan-text");
    if (scanText) {
      scanText.textContent = "Align the QR code inside the frame";
      scanText.classList.remove("error");
    }

    scanning = true;
    requestAnimationFrame(scanLoop);
  } catch (err) {
    console.error("Camera error:", err);
    const scanText = document.querySelector(".scan-text");
    if (scanText) {
      scanText.innerHTML =
        'Camera access required<br><span style="font-size: 14px;">Please enable permission</span>';
      scanText.classList.add("error");
    }
  }
}

function stopCamera() {
  scanning = false;
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    if (videoElement) videoElement.srcObject = null;
    localStream = null;
  }
}

async function handleQRCode(decodedText) {
  const payload = (decodedText || "").trim();
  if (!payload) return;

  if (!authToken) {
    alert("Not authenticated yet. Open the app as a Telegram Mini App.");
    return;
  }

  showLoading();
  try {
    const res = await fetch(`${API_BASE}/api/attractions/scan`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ code: payload }),
    });

    const data = await res.json();
    hideLoading();

    if (!res.ok || !data.success) {
      alert(`❌ ${data.message || data.error || "Scan failed"}`);
      startCamera();
      return;
    }

    const balanceElement = document.querySelector(".coin-balance");
    if (balanceElement) {
      balanceElement.innerHTML = `${data.newBalance} <div class="coin-icon"></div>`;
    }

    alert(`✅ Scan accepted!\n+${data.addedCoins} coins`);
    startCamera();
  } catch (err) {
    hideLoading();
    console.error("SCAN FETCH ERROR:", err);
    alert("Network error talking to backend when scanning QR.");
    startCamera();
  }
}

function scanLoop() {
  if (!scanning) return;

  if (videoElement && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
    const w = videoElement.videoWidth;
    const h = videoElement.videoHeight;
    if (w && h) {
      qrCanvas.width = w;
      qrCanvas.height = h;

      qrCtx.drawImage(videoElement, 0, 0, w, h);
      const imageData = qrCtx.getImageData(0, 0, w, h);

      const code = jsQR(imageData.data, w, h, { inversionAttempts: "dontInvert" });
      if (code && (code.data || "").trim()) {
        scanning = false;
        stopCamera();
        handleQRCode(code.data);
        return;
      }
    }
  }

  requestAnimationFrame(scanLoop);
}

// ---------------- TAB SWITCH + MAP (FIXED) ----------------
// ✅ IMPORTANT FIXES:
// 1) remove duplicate map system (keep ONLY leafletMap)
// 2) setActiveTab calls initMapOnce() and invalidates leafletMap (not "map")
function setActiveTab(viewId) {
  // show correct section
  document.querySelectorAll(".view-section").forEach((sec) => {
    sec.classList.toggle("active", sec.id === viewId);
  });

  // highlight nav item
  document.querySelectorAll("nav .nav-item").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === viewId);
  });

  // camera only on scan tab
  if (viewId === "scan-view") startCamera();
  else stopCamera();

  // init map once + resize after visible
  if (viewId === "map-view") {
    initMapOnce();
    setTimeout(() => {
      try { leafletMap?.invalidateSize(true); } catch (e) {}
    }, 200);
  }
}


// ---------------- BUY BUTTONS ----------------
document.addEventListener("DOMContentLoaded", async () => {
  await initAuth();

  document.querySelectorAll("nav .nav-item").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const viewId = a.dataset.view;
      if (!viewId) return;
      setActiveTab(viewId);
    });
  });

  // default
  setActiveTab("scan-view");

  // Start camera if scan view is active
  const scanView = document.getElementById("scan-view");
  if (scanView && scanView.classList.contains("active")) startCamera();
});


// ---------------- MAP (KEEP ONE SYSTEM) ----------------
let leafletMap = null;
let leafletMarkers = [];
let mapReady = false;

// TEMP demo points (aligned to Batumi / your backend seed coords)
const MAP_POINTS = [
  // -------- ATTRACTIONS --------
  {
    type: "attraction",
    name: "Ali and Nino",
    lat: 41.6539,
    lng: 41.6360,
    reward: 10,
    imgUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSnu5nA0CdvI7yiZIQv-DLOpP2gtfjQCZF-vQ&s"
  },
  {
    type: "attraction",
    name: "Alphabetic Tower",
    lat: 41.656088567441216,
    lng: 41.639600470801206,
    reward: 10,
    imgUrl: "https://cdn.georgia.to/img/thumbnails/4SPspoJhk72WETe3sSjND5_smedium.jpg"
  },
  {
    type: "attraction",
    name: "GITA TouristHack 2025",
    lat: 41.62386745993197,
    lng: 41.62490440795824,
    reward: 10,
    imgUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTg1Jsw8MUbLboM9usq0ZrNebJ63j6Beze7vQ&s"
  },

  // -------- REWARDS / PARTNERS (demo nearby) --------
  {
    type: "reward",
    name: "Restaurant: Tavaduri",
    lat: 41.6552,
    lng: 41.6348,
    price: 200,
    imgUrl: "https://www.infobatumi.ge/wp-content/uploads/2023/12/saxinkle-tavaduri-INFOBATUMI-GE-01.jpg"
  },
  {
    type: "reward",
    name: "Cafe: Art House",
    lat: 41.6570,
    lng: 41.6390,
    price: 150,
    imgUrl: "https://cdn.prod.website-files.com/60b0468050505503acd961bd/62045f8ebc2ef914f276c0f2_ArtHouseCafe_print_8318_x.jpg"
  },
  {
    type: "reward",
    name: "Museum of Arts",
    lat: 41.6518,
    lng: 41.6376,
    price: 100,
    imgUrl: "https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&w=300&q=80"
  },
];

function initMapOnce() {
  if (mapReady) return;

  const mapDiv = document.getElementById("map");
  if (!mapDiv) return;

  leafletMap = L.map("map", { zoomControl: true });

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution:
        "Tiles &copy; Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
    }
  ).addTo(leafletMap);

  // ✅ center around Batumi / attractions
  leafletMap.setView([41.6539, 41.6360], 14);

  renderMapPoints(MAP_POINTS);

  mapReady = true;

  // Important: map needs a resize once it's visible
  setTimeout(() => leafletMap.invalidateSize(), 50);
}

function renderMapPoints(points) {
  leafletMarkers.forEach((m) => m.remove());
  leafletMarkers = [];

  points.forEach((p) => {
    const label =
      p.type === "attraction"
        ? `<b>${p.name}</b><br/>Reward: ${p.reward} coins`
        : `<b>${p.name}</b><br/>Price: ${p.price} coins`;

    const icon = L.icon({
      iconUrl: p.imgUrl,
      iconSize: [44, 44],
      iconAnchor: [22, 44],
      popupAnchor: [0, -44],
      className: "poi-icon",
    });

    const marker = L.marker([p.lat, p.lng], { icon })
      .addTo(leafletMap)
      .bindPopup(label);

    leafletMarkers.push(marker);
  });
}
