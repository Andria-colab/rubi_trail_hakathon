console.log("🔥 FRONTEND SCRIPT LOADED");

// Render backend
const API_BASE = "https://rubi-trail-hakathon.onrender.com";

let authToken = null;

// ---------- AUTH (Telegram Mini App) ----------
async function initAuth() {
  try {
    const tg = window.Telegram?.WebApp;
    if (!tg) {
      alert("Open this inside Telegram.");
      return;
    }

    tg.ready();

    // IMPORTANT: send initData to backend for verification
    const initData = tg.initData;
    if (!initData) {
      alert("Telegram initData missing.");
      return;
    }

    const res = await fetch(`${API_BASE}/auth/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Auth failed response:", data);
      alert(data.error || "Auth failed (backend rejected Telegram initData).");
      return;
    }

    authToken = String(data.token);
    console.log("✅ Auth token:", authToken);

    const balanceElement = document.querySelector(".coin-balance");
    if (balanceElement && data.user) {
      balanceElement.innerHTML = `${data.user.coins} <div class="coin-icon"></div>`;
    }
  } catch (err) {
    console.error("Auth failed:", err);
    alert("Could not connect to backend (auth). Is Render backend running?");
  }
}

function getAuthHeaders() {
  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + authToken,
  };
}

async function ensureAuth() {
  if (authToken) return true;
  await initAuth();
  return !!authToken;
}

// ---------- TAB SWITCHING / CAMERA ----------
function switchTab(viewId, navElement) {
  showLoading();

  setTimeout(() => {
    document.querySelectorAll(".view-section").forEach((v) => v.classList.remove("active"));
    const activeView = document.getElementById(viewId);
    if (activeView) activeView.classList.add("active");

    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    navElement.classList.add("active");

    if (viewId === "scan-view") startCamera();
    else stopCamera();

    hideLoading();
  }, 200);
}

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

function scanLoop() {
  if (!scanning) return;

  if (videoElement && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
    const width = videoElement.videoWidth;
    const height = videoElement.videoHeight;

    if (width && height) {
      qrCanvas.width = width;
      qrCanvas.height = height;

      qrCtx.drawImage(videoElement, 0, 0, width, height);
      const imageData = qrCtx.getImageData(0, 0, width, height);

      const code = jsQR(imageData.data, width, height, { inversionAttempts: "dontInvert" });

      if (code && code.data) {
        console.log("✅ QR payload:", code.data);
        scanning = false;
        stopCamera();
        handleQRCode(code.data);
        return;
      }
    }
  }

  requestAnimationFrame(scanLoop);
}

// ---------- BACKEND CALL FOR QR ----------
async function handleQRCode(decodedText) {
  const ok = await ensureAuth();
  if (!ok) {
    alert("Not authenticated yet. Reload the page.");
    return;
  }

  showLoading();
  try {
    const res = await fetch(`${API_BASE}/api/attractions/scan`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ qrText: decodedText }),
    });

    const data = await res.json();
    hideLoading();

    if (!res.ok) {
      console.error("Scan error:", data);
      alert(`❌ Scan failed: ${data.message || data.error || "Unknown error"}`);
      return;
    }

    if (data.success) {
      const balanceElement = document.querySelector(".coin-balance");
      if (balanceElement) {
        balanceElement.innerHTML = `${data.newBalance} <div class="coin-icon"></div>`;
      }
      alert(`✅ ${data.message}\n+${data.addedCoins} coins`);
    } else {
      alert(`❌ ${data.message}`);
    }
  } catch (err) {
    hideLoading();
    console.error(err);
    alert("Network error talking to backend when scanning QR.");
  }
}

// ---------- BUY REWARD ----------
async function buyReward(rewardId, titleForAlert) {
  const ok = await ensureAuth();
  if (!ok) {
    alert("Not authenticated yet.");
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

    if (!res.ok) {
      console.error("BUY error:", data);
      alert(`❌ ${data.message || "Could not buy reward."}`);
      return;
    }

    if (data.success) {
      const balanceElement = document.querySelector(".coin-balance");
      if (balanceElement) {
        balanceElement.innerHTML = `${data.newBalance} <div class="coin-icon"></div>`;
      }

      // Backend sends QR to Telegram DM. This is just a fallback link.
      alert(`✅ Bought: ${titleForAlert}\nVoucher sent to your Telegram via bot.\n\nLink:\n${data.voucher.redeemUrl}`);
      console.log("Voucher URL:", data.voucher.redeemUrl);
    } else {
      alert(`❌ ${data.message || "Could not buy reward."}`);
    }
  } catch (err) {
    hideLoading();
    console.error("Network error buying reward:", err);
    alert("Network error buying reward.");
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

// ---------- SAFE AREAS ----------
function updateSafeAreas() {
  const header = document.querySelector("header");
  const nav = document.querySelector("nav");

  const safeAreaTop = getComputedStyle(document.documentElement).getPropertyValue("--safe-area-top");
  const safeAreaBottom = getComputedStyle(document.documentElement).getPropertyValue("--safe-area-bottom");

  if (safeAreaTop && safeAreaTop !== "0px" && header) header.style.paddingTop = safeAreaTop;
  if (safeAreaBottom && safeAreaBottom !== "0px" && nav) nav.style.paddingBottom = safeAreaBottom;
}

window.addEventListener("resize", updateSafeAreas);
window.addEventListener("orientationchange", updateSafeAreas);

// ---------- DOM READY ----------
document.addEventListener("DOMContentLoaded", async () => {
  updateSafeAreas();
  await initAuth();

  // BUY buttons
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".btn-buy");
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    const rewardId = btn.dataset.rewardId;
    if (!rewardId) {
      alert("Missing data-reward-id on this BUY button.");
      return;
    }

    const card = btn.closest(".card");
    const title = card?.querySelector(".card-title")?.textContent?.trim() || `Reward #${rewardId}`;

    buyReward(rewardId, title);
  });

  // start scan camera if scan tab is active
  const initialScanView = document.getElementById("scan-view");
  if (initialScanView && initialScanView.classList.contains("active")) {
    startCamera();
  }
});
