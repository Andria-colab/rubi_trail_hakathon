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

function setCoinBalance(value) {
  // Works with both:
  // 1) <span id="coin-count">0</span> ...
  // 2) <div class="coin-balance"> ... </div> (older)
  const coinCount = document.getElementById("coin-count");
  if (coinCount) {
    coinCount.textContent = String(value ?? 0);
    return;
  }

  const balanceElement = document.querySelector(".coin-balance");
  if (balanceElement) {
    balanceElement.innerHTML = `${value ?? 0} <div class="coin-icon"></div>`;
  }
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

    if (data.user) setCoinBalance(data.user.coins);

const startParam = tg?.initDataUnsafe?.start_param || "";

// prevent double redeem on refresh
if (startParam) {
  const key = `redeemed:${startParam}`;
  if (!sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, "1");
    // optional: switch to scan view or stay where you are
    // setActiveTab("scan-view");
    redeemCode(startParam, "nfc");
  }
}

  } catch (err) {
    console.error("Auth failed:", err);
    alert("Could not connect to backend (auth).");
  }
}

// ---------------- REWARDS (NEW - IMPORTANT) ----------------
async function loadRewards() {
  const container = document.getElementById("rewards-list");
  if (!container) return;

  if (!authToken) {
    container.innerHTML = `<div style="padding:16px;">Not authenticated yet.</div>`;
    return;
  }

  showLoading();
  try {
    const res = await fetch(`${API_BASE}/api/rewards`, {
      method: "GET",
      headers: getAuthHeaders(),
    });

    const data = await res.json();
    hideLoading();

    if (!res.ok) {
      console.error("Rewards load error:", data);
      container.innerHTML = `<div style="padding:16px;">❌ ${data.error || "Failed to load rewards"}</div>`;
      return;
    }

    // Update coins shown in header
    if (typeof data.userCoins !== "undefined") setCoinBalance(data.userCoins);

    const rewards = Array.isArray(data.rewards) ? data.rewards : [];
    if (rewards.length === 0) {
      container.innerHTML = `<div style="padding:16px;">No rewards available.</div>`;
      return;
    }

    // Render reward cards (keeps your .card/.card-content styles)
    container.innerHTML = rewards.map((r) => {
      const img =
        (r.service && r.service.logoUrl) ||
        "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=400&q=80";

      const serviceName = (r.service && r.service.name) ? r.service.name : "Partner";
      const desc = r.description || "";

      return `
        <div class="card">
          <img src="${img}" class="card-img" alt="${serviceName}">
          <div class="card-content">
            <div>
              <div class="card-title">${r.title}</div>
              <div class="card-reward">PRICE: ${r.priceCoins} <div class="coin-small"></div></div>
              <div class="card-location">${serviceName}</div>
              <p class="card-desc">${desc}</p>
            </div>
            <button class="btn-buy" data-reward-id="${r.id}" type="button">BUY</button>
          </div>
        </div>
      `;
    }).join("");
  } catch (err) {
    hideLoading();
    console.error("Rewards load exception:", err);
    container.innerHTML = `<div style="padding:16px;">❌ Network error loading rewards</div>`;
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

  // stop the scan loop / camera BEFORE redeeming (prevents double triggers)
  scanning = false;
  stopCamera();

  // unified redeem (same endpoint, same code)
  await redeemCode(payload, "qr");

  // resume scanning after redeem finishes (optional)
  startCamera();
}

async function redeemCode(code, source = "qr") {
  const payload = (code || "").trim();
  if (!payload) return;

  if (!authToken) {
    alert("Not authenticated yet.");
    return;
  }

  showLoading();
  try {
    const res = await fetch(`${API_BASE}/api/attractions/scan`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ code: payload, source }), // source optional
    });

    // safer parsing (some errors may return HTML)
    const rawText = await res.text();
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch (_) {}

    hideLoading();

    if (!res.ok || !data?.success) {
      const details =
        (data && (data.message || data.error)) ||
        rawText ||
        `HTTP ${res.status}`;
      alert(`❌ Redeem failed\n\n${details}`);
      return;
    }

    if (typeof data.newBalance !== "undefined") setCoinBalance(data.newBalance);

    // ✅ show attraction + voucher if backend returns them
    const aName = data.attraction?.name ? `\nPlace: ${data.attraction.name}` : "";
    const aDesc = data.attraction?.description ? `\n\n${data.attraction.description}` : "";
    const voucher = data.voucher?.redeemUrl ? `\n\nVoucher: ${data.voucher.redeemUrl}` : "";

    alert(
      `✅ Success!\n+${data.addedCoins ?? 0} coins\nNew balance: ${data.newBalance ?? "?"}` +
      aName + aDesc + voucher
    );

  } catch (err) {
    hideLoading();
    console.error("Redeem error:", err);
    alert("Network error talking to backend.");
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

  // ✅ load rewards when rewards tab opens
  if (viewId === "rewards-view") {
    loadRewards();
  }

  // init map once + resize after visible
  if (viewId === "map-view") {
    initMapOnce();
    setTimeout(() => {
      try { leafletMap?.invalidateSize(true); } catch (e) {}
    }, 200);
  }
}

// ---------------- BUY BUTTONS (NEW - IMPORTANT) ----------------
// Delegated handler so dynamically rendered rewards still work
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-buy");
  if (!btn) return;

  e.preventDefault();
  e.stopPropagation();

  if (!authToken) {
    alert("Not authenticated yet.");
    return;
  }

  const rewardId = btn.dataset.rewardId;
  if (!rewardId) {
    alert("Missing data-reward-id on BUY button.");
    return;
  }

  showLoading();
  try {
    const res = await fetch(`${API_BASE}/api/rewards/${rewardId}/buy`, {
      method: "POST",
      headers: getAuthHeaders(),
    });

    const data = await res.json();
    hideLoading();

    if (!res.ok || !data.success) {
      alert(`❌ ${data.message || "Could not buy reward."}`);
      return;
    }

    if (typeof data.newBalance !== "undefined") setCoinBalance(data.newBalance);

    alert(`✅ Voucher created!\n${data.voucher?.redeemUrl || ""}`);

    // refresh rewards so user sees updated state (optional but helpful)
    loadRewards();
  } catch (err) {
    hideLoading();
    console.error("BUY error:", err);
    alert("Network error buying reward.");
  }
});

// ---------------- MAP (KEEP ONE SYSTEM) ----------------
let leafletMap = null;
let leafletMarkers = [];
let mapReady = false;

// TEMP demo points (aligned to Batumi / your backend seed coords)
const MAP_POINTS = [
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

  leafletMap.setView([41.6539, 41.6360], 14);

  renderMapPoints(MAP_POINTS);

  mapReady = true;

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

// ---------------- INIT ----------------
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