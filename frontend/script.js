console.log("🔥 FRONTEND SCRIPT LOADED");

const API_BASE = "https://rubi-trail-hakathon.onrender.com";
let authToken = null;

/* ================= AUTH ================= */

async function initAuth() {
  try {
    const tg = window.Telegram?.WebApp;

    let userId;
    let userName;

    if (tg?.initDataUnsafe?.user?.id) {
      // Telegram Mini App
      tg.ready();
      userId = String(tg.initDataUnsafe.user.id);
      userName =
        tg.initDataUnsafe.user.first_name ||
        tg.initDataUnsafe.user.username ||
        "Telegram User";
    } else {
      // ✅ Browser fallback: create a stable numeric id
      userId = localStorage.getItem("web_user_id");
      if (!userId) {
        userId = String(Math.floor(1_000_000_000 + Math.random() * 9_000_000_000));
        localStorage.setItem("web_user_id", userId);
      }
      userName = "Web User";
    }

    const res = await fetch(`${API_BASE}/auth/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telegram_id: userId, name: userName }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Auth failed:", data);
      alert("Auth failed");
      return;
    }

    authToken = String(data.token);
    updateCoins(data.user?.coins ?? 0);
  } catch (err) {
    console.error("Auth error:", err);
    alert("Could not authenticate");
  }
}

function getAuthHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer " + authToken,
  };
}

function updateCoins(coins) {
  const el = document.querySelector(".coin-balance");
  if (el) el.innerHTML = `${coins} <div class="coin-icon"></div>`;
}

/* ================= LOADING ================= */

function showLoading() {
  document.getElementById("loading")?.classList.add("active");
}
function hideLoading() {
  document.getElementById("loading")?.classList.remove("active");
}

/* ================= NAV / VIEW ================= */

function switchTab(viewId, navElement) {
  showLoading();

  setTimeout(() => {
    document.querySelectorAll(".view-section").forEach(v => v.classList.remove("active"));
    document.getElementById(viewId)?.classList.add("active");

    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    navElement.classList.add("active");

    if (viewId === "scan-view") startCamera();
    else stopCamera();

    hideLoading();
  }, 150);
}
// IMPORTANT: make it available for inline onclick="" in HTML
window.switchTab = switchTab;

/* ================= CAMERA / QR ================= */

const videoElement = document.getElementById("camera-stream");
let localStream = null;
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

    scanning = true;
    requestAnimationFrame(scanLoop);
  } catch (err) {
    console.error("Camera error:", err);
    alert("Camera permission required");
  }
}

function stopCamera() {
  scanning = false;
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (videoElement) videoElement.srcObject = null;
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

      const img = qrCtx.getImageData(0, 0, w, h);
      const code = jsQR(img.data, w, h);

      if (code?.data) {
        scanning = false;
        stopCamera();
        handleQRCode(code.data);
        return;
      }
    }
  }

  requestAnimationFrame(scanLoop);
}

/* ================= SCAN ================= */

async function handleQRCode(qrText) {
  if (!authToken) {
    alert("Not authenticated yet. Reload the page.");
    return;
  }

  showLoading();
  const res = await fetch(`${API_BASE}/api/attractions/scan`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ qrText }),
  });
  const data = await res.json().catch(() => ({}));
  hideLoading();

  if (!res.ok) {
    console.error("Scan failed:", data);
    alert(data.message || "Scan failed");
    return;
  }

  updateCoins(data.newBalance);
  alert(`✅ +${data.addedCoins} coins`);
}

/* ================= BUY ================= */

async function buyReward(rewardId, title) {
  if (!authToken) {
    alert("Not authenticated yet. Reload the page.");
    return;
  }

  showLoading();
  const res = await fetch(`${API_BASE}/api/rewards/${rewardId}/buy`, {
    method: "POST",
    headers: getAuthHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  hideLoading();

  if (!res.ok) {
    console.error("Buy failed:", data);
    alert(data.message || "Purchase failed");
    return;
  }

  updateCoins(data.newBalance);

  // ✅ Open voucher immediately (Telegram in-app or browser tab)
  if (data.voucher?.redeemUrl) {
    const tg = window.Telegram?.WebApp;
    if (tg?.openLink) tg.openLink(data.voucher.redeemUrl);
    else window.open(data.voucher.redeemUrl, "_blank");
  }

  alert(`✅ Bought: ${title}`);
}

/* ================= DOM ================= */

document.addEventListener("DOMContentLoaded", async () => {
  await initAuth();

  // Buy button handler
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-buy");
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    const rewardId = btn.dataset.rewardId;
    if (!rewardId) {
      alert("Missing data-reward-id on BUY button.");
      return;
    }

    const card = btn.closest(".card");
    const title =
      card?.querySelector(".card-reward")?.textContent?.trim() ||
      `Reward #${rewardId}`;

    buyReward(rewardId, title);
  });

  // Auto-start camera if scan view is active
  const initialScanView = document.getElementById("scan-view");
  if (initialScanView?.classList.contains("active")) {
    startCamera();
  }
});
