console.log("🔥 FRONTEND SCRIPT LOADED");

const API_BASE = "https://rubi-trail-hakathon.onrender.com";


let authToken = null; // this will be our "user id" from backend

function debugModal() {
  const modal = document.getElementById("reward-modal");
  if (!modal) {
    console.warn("DEBUG: #reward-modal not found");
    return;
  }

  const logState = (tag) => {
    const cs = getComputedStyle(modal);
    console.log(`[MODAL ${tag}]`,
      "data-open=", modal.getAttribute("data-open"),
      "class=", modal.className,
      "display=", cs.display,
      "opacity=", cs.opacity,
      "visibility=", cs.visibility,
      "zIndex=", cs.zIndex,
      "inDOM=", document.body.contains(modal)
    );
  };

  // Log immediately + every 200ms for 2 seconds after open (we'll call it)
  window.__logModalState = logState;

  // Watch attribute changes (class/data-open/style)
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") {
        console.log("MODAL ATTR CHANGED:", m.attributeName);
        logState("attr-change");
      }
    }
  });
  mo.observe(modal, { attributes: true, attributeFilter: ["class", "style", "data-open"] });

  // Detect if modal node gets removed/replaced
  const ro = new MutationObserver(() => {
    const stillThere = document.body.contains(modal);
    if (!stillThere) {
      console.error("🚨 MODAL NODE REMOVED FROM DOM!");
    }
  });
  ro.observe(document.body, { childList: true, subtree: true });

  logState("init");
}


// ---------- AUTH ----------

async function initAuth() {
    try {
        const res = await fetch(`${API_BASE}/auth/telegram`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                telegram_id: "6732377993",
                name: "Demo User"
            })
        });

        const data = await res.json();
        authToken = data.token; // e.g. "1"

        // update coin balance in header from backend
        const balanceElement = document.querySelector(".coin-balance");
        if (balanceElement && data.user) {
            balanceElement.innerHTML = `${data.user.coins} <div class="coin-icon"></div>`;
        }
    } catch (err) {
        console.error("Auth failed:", err);
        alert("Could not connect to backend (auth). Is Flask running?");
    }
}

function getAuthHeaders() {
    return {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + authToken
    };
}

// ---------- TAB SWITCHING / CAMERA ----------

function switchTab(viewId, navElement) {
    showLoading();

    setTimeout(() => {
        const views = document.querySelectorAll(".view-section");
        views.forEach(view => view.classList.remove("active"));

        const activeView = document.getElementById(viewId);
        if (activeView) activeView.classList.add("active");

        const navItems = document.querySelectorAll(".nav-item");
        navItems.forEach(item => item.classList.remove("active"));
        navElement.classList.add("active");

        if (viewId === "scan-view") startCamera();
        else stopCamera();

        // ✅ STEP 5 GOES HERE
        if (viewId === "map-view") {
            initMapOnce(); // creates the map the first time you open Map tab
            if (leafletMap) setTimeout(() => leafletMap.invalidateSize(), 50);
        }

        hideLoading();
    }, 300);
}


const videoElement = document.getElementById("camera-stream");
let localStream;
let scanning = false;

// hidden canvas for QR decoding
const qrCanvas = document.createElement("canvas");
const qrCtx = qrCanvas.getContext("2d");

async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment" }
        });
        localStream = stream;
        if (videoElement) {
            videoElement.srcObject = stream;
        }

        // reset text if it had an error before
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
        localStream.getTracks().forEach(track => track.stop());
        if (videoElement) {
            videoElement.srcObject = null;
        }
        localStream = null;
    }
}


function scanLoop() {
    const modal = document.getElementById("reward-modal");
    if (modal && modal.getAttribute("data-open") === "1") {
        requestAnimationFrame(scanLoop); // keep loop alive but don't scan
        return;
    }    
    if (!scanning || rewardModalOpen) return;

    if (videoElement && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
        const width = videoElement.videoWidth;
        const height = videoElement.videoHeight;

        if (width && height) {
            qrCanvas.width = width;
            qrCanvas.height = height;

            qrCtx.drawImage(videoElement, 0, 0, width, height);
            const imageData = qrCtx.getImageData(0, 0, width, height);

            const code = jsQR(imageData.data, width, height, {
                inversionAttempts: "dontInvert"
            });

            if (code) {
                const payload = (code.data || "").trim();
                console.log("QR payload:", JSON.stringify(payload));

                // 🚫 ignore empty reads
                if (!payload) {
                    requestAnimationFrame(scanLoop);
                    return;
                }

                scanning = false;
                stopCamera();
                handleQRCode(payload);
                return;
            }
        }
    }

    requestAnimationFrame(scanLoop);
}

// ---------- BACKEND CALL FOR QR ----------


let rewardModalOpen = false;

function showRewardModal({ coins, title, description }) {
  const modal = document.getElementById("reward-modal");
  if (!modal) return;

  document.getElementById("modal-coins").textContent = `+${coins}`;
  document.getElementById("modal-title").textContent = title || "Sightseeing";
  document.getElementById("modal-desc").textContent = description || "";

  rewardModalOpen = true;
  modal.setAttribute("data-open", "1");

  // prevent the “same tap” that triggered the scan from instantly closing it
  modal.dataset.justOpened = "1";
  setTimeout(() => delete modal.dataset.justOpened, 250);
}

function hideRewardModal() {
  const modal = document.getElementById("reward-modal");
  if (!modal) return;
  modal.setAttribute("data-open", "0");
  rewardModalOpen = false;

  // optionally restart scanning after close
  startCamera();
}



async function handleQRCode(decodedText) {
    const payload = (decodedText || "").trim();
    console.log("handleQRCode() payload =", JSON.stringify(payload), "authToken =", authToken);

    if (!payload) {
        console.warn("Empty QR payload, ignoring");
        return;
    }

    if (!authToken) {
        console.warn("No authToken yet; trying initAuth()");
        await initAuth();
        if (!authToken) {
            alert("Not authenticated yet. Try reloading the page.");
            return;
        }
    }

    showLoading();
    try {
        const res = await fetch(`${API_BASE}/api/attractions/scan`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({ code: payload })
        });

        // Read as text first (so JSON parse can't hide the real response)
        const text = await res.text();
        console.log("scan status =", res.status, "raw response =", text);

        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch (e) {
            console.error("Response was not JSON:", e);
            throw new Error("Backend returned non-JSON response");
        }

        hideLoading();

        if (!res.ok) {
            alert(`❌ ${data.message || data.error || `HTTP ${res.status}`}`);
            return;
        }

hideLoading();

if (data.success) {
    const balanceElement = document.querySelector(".coin-balance");
    if (balanceElement) {
        balanceElement.innerHTML = `${data.newBalance} <div class="coin-icon"></div>`;
    }

    // ⏱️ IMPORTANT: wait for loading overlay + click stack to fully clear
    const coins = data.addedCoins;
const title = data.attraction?.title || "Sightseeing";
const description = data.attraction?.description || "";

alert(
  `✅ Coins redeemed!\n\n` +
  `+${coins} coins granted\n\n` +
  `${title}\n\n` +
  `${description}`
);

// (optional) restart scanning after user closes alert
startCamera();

}

    } catch (err) {
        hideLoading();
        console.error("SCAN FETCH ERROR:", err, "name:", err?.name, "message:", err?.message);
        alert("Network error talking to backend when scanning QR.");
    }
}


// ---------- LOADING OVERLAY ----------

function showLoading() {
    const el = document.getElementById("loading");
    if (el) el.classList.add("active");
}

function hideLoading() {
    const el = document.getElementById("loading");
    if (el) el.classList.remove("active");
}

// ---------- DOM READY ----------

document.addEventListener("DOMContentLoaded", async () => {
    await initAuth();     // make sure authToken is set before scanning
    debugModal();         // ✅ now modal is in the DOM, so observers attach correctly

    // (optional but strong) move modal to <body> so view switching can't affect it
    const modal = document.getElementById("reward-modal");
    if (modal && modal.parentElement !== document.body) {
        document.body.appendChild(modal);
        console.log("✅ Moved reward modal to <body>");
    }
    // One click handler for all BUY buttons (works even if HTML changes later)
    document.addEventListener("click", async (e) => {
        const btn = e.target.closest(".btn-buy");
        if (!btn) return;

        console.log("BUY CLICKED", btn);

        e.preventDefault();
        e.stopPropagation();

        if (!authToken) {
            alert("Not authenticated yet.");
            return;
        }

        // ✅ Use data-reward-id from HTML
        const rewardId = btn.dataset.rewardId;
        if (!rewardId) {
            alert("Missing data-reward-id on this BUY button.");
            console.error("BUY button missing data-reward-id:", btn);
            return;
        }

        const card = btn.closest(".card");
        const title = card
            ? (card.querySelector(".card-title")?.textContent || `Reward #${rewardId}`)
            : `Reward #${rewardId}`;

        showLoading();
        try {
            const res = await fetch(`${API_BASE}/api/rewards/${rewardId}/buy`, {
                method: "POST",
                headers: getAuthHeaders()
            });

            const data = await res.json();
            hideLoading();

            if (data.success) {
                const balanceElement = document.querySelector(".coin-balance");
                if (balanceElement) {
                    balanceElement.innerHTML = `${data.newBalance} <div class="coin-icon"></div>`;
                }

                alert(`✅ Bought: ${title}\nVoucher created!\n${data.voucher.redeemUrl}`);
                console.log("Voucher URL:", data.voucher.redeemUrl);
            } else {
                alert(`❌ ${data.message || "Could not buy reward."}`);
                console.error("BUY failed:", data);
            }
        } catch (err) {
            hideLoading();
            console.error("Network error buying reward:", err);
            alert("Network error buying reward.");
        }


    });

    // If initial tab is scan-view, start camera immediately
    const initialScanView = document.getElementById("scan-view");
    if (initialScanView && initialScanView.classList.contains("active")) {
        startCamera();
    }
});

// ---------- SAFE AREAS ----------

function updateSafeAreas() {
    const header = document.querySelector("header");
    const nav = document.querySelector("nav");

    const safeAreaTop = getComputedStyle(document.documentElement).getPropertyValue("--safe-area-top");
    const safeAreaBottom = getComputedStyle(document.documentElement).getPropertyValue("--safe-area-bottom");

    if (safeAreaTop && safeAreaTop !== "0px" && header) {
        header.style.paddingTop = safeAreaTop;
    }

    if (safeAreaBottom && safeAreaBottom !== "0px" && nav) {
        nav.style.paddingBottom = safeAreaBottom;
    }
}

window.addEventListener("resize", updateSafeAreas);
window.addEventListener("orientationchange", updateSafeAreas);
updateSafeAreas();

// ---------- OPTIONAL: RENDER QR FROM BACKEND STRING (for later) ----------

async function renderQRCodeFromBackend(codeString) {
    const container = document.getElementById("generated-qr-container");
    if (!container) return;

    container.innerHTML = "";

    const qrCanvasOut = document.createElement("canvas");
    container.appendChild(qrCanvasOut);

    // Requires a QRCode library if you actually use this
    new QRCode(qrCanvasOut, {
        text: codeString,
        width: 200,
        height: 200
    });
}
let leafletMap = null;
let leafletMarkers = [];
let mapReady = false;

// TEMP demo points (replace with your real DB / backend later)
const MAP_POINTS = [
  // -------- ATTRACTIONS --------
  {
    type: "attraction",
    name: "Ali and Nino Statue",
    lat: 40.3659,
    lng: 49.8444,
    reward: 20,
    imgUrl: "https://images.unsplash.com/photo-1550543503-68d2a45d0705?auto=format&fit=crop&w=300&q=80"
  },
  {
    type: "attraction",
    name: "Anbani Tower",
    lat: 41.65607154394626,
    lng: 41.63954869118999,
    reward: 15,
    imgUrl: "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?auto=format&fit=crop&w=300&q=80"
  },
  {
    type: "attraction",
    name: "GITA TouristHack 2025",
    lat: 41.6239155513949,
    lng:  41.624797116096794,
    reward: 15,
    imgUrl: "https://images.unsplash.com/photo-1580052614386-5f1d5a1d0c6e?auto=format&fit=crop&w=300&q=80"
  },

  // -------- REWARDS / PARTNERS --------
  {
    type: "reward",
    name: "Restaurant: Tavaduri",
    lat: 40.3714,
    lng: 49.8468, // near Fountain Square area
    price: 200,
    imgUrl: "https://www.infobatumi.ge/wp-content/uploads/2023/12/saxinkle-tavaduri-INFOBATUMI-GE-01.jpg"
  },
  {
    type: "reward",
    name: "Cafe: Art House",
    lat: 40.3726,
    lng: 49.8532, // Nizami Street area
    price: 150,
    imgUrl: "https://cdn.prod.website-files.com/60b0468050505503acd961bd/62045f8ebc2ef914f276c0f2_ArtHouseCafe_print_8318_x.jpg"
  },
  {
    type: "reward",
    name: "Museum of Modern Art",
    lat: 40.3896,
    lng: 49.8447,
    price: 100,
    imgUrl: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRJb41_VwDkuZfPbUx91jHknEyGgPOTFKpNkQ&s"
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
    attribution: "Tiles &copy; Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
  }
).addTo(leafletMap);


  // Start centered on Baku-ish (adjust to your city)
  leafletMap.setView([40.3700, 49.8400], 14);

  renderMapPoints(MAP_POINTS);

  mapReady = true;

  // Important: map needs a resize once it's visible
  setTimeout(() => leafletMap.invalidateSize(), 50);
}



function renderMapPoints(points) {
  leafletMarkers.forEach(m => m.remove());
  leafletMarkers = [];

  points.forEach(p => {
    const label =
      p.type === "attraction"
        ? `<b>${p.name}</b><br/>Reward: ${p.reward} coins`
        : `<b>${p.name}</b><br/>Price: ${p.price} coins`;

    const icon = L.icon({
      iconUrl: p.imgUrl,      // ✅ your image URL
      iconSize: [44, 44],     // size of the image on the map
      iconAnchor: [22, 44],   // “point” of the marker (bottom middle)
      popupAnchor: [0, -44],  // popup appears above the icon
      className: "poi-icon"
    });

    const marker = L.marker([p.lat, p.lng], { icon })
      .addTo(leafletMap)
      .bindPopup(label);

    leafletMarkers.push(marker);
  });
}


window.addEventListener("backend-qr-code", e => {
    const qrString = e.detail; // e.g., "SOME_QR_DATA"
    renderQRCodeFromBackend(qrString);
});