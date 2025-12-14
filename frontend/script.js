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

    // Expand app (nice UX)
    try { tg?.expand(); } catch (e) {}

    const initData = tg?.initData || "";
    const initUnsafe = tg?.initDataUnsafe || {};
    console.log("Telegram WebApp exists?", Boolean(tg));
    console.log("initData length:", initData.length);
    console.log("initDataUnsafe:", initUnsafe);

    // If initData missing, you're NOT launched as a Mini App.
    // This happens even if you clicked a link inside chat.
    if (!initData) {
      alert(
        "This link is opened as a normal browser tab.\n\n" +
        "Open it as a Telegram Mini App (via bot button / startapp) so Telegram can provide login."
      );
      return;
    }

    const res = await fetch(`${API_BASE}/auth/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Auth error:", data);
      alert("Telegram auth failed. Check backend logs.");
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

// ---------------- TAB SWITCH ----------------
function switchTab(viewId, navElement) {
  showLoading();

  setTimeout(() => {
    document.querySelectorAll(".view-section").forEach((v) => v.classList.remove("active"));
    document.getElementById(viewId)?.classList.add("active");

    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    navElement.classList.add("active");

    if (viewId === "scan-view") startCamera();
    else stopCamera();

    hideLoading();
  }, 250);
}

// ---------------- BUY BUTTONS ----------------
document.addEventListener("DOMContentLoaded", async () => {
  await initAuth();

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

      const balanceElement = document.querySelector(".coin-balance");
      if (balanceElement) {
        balanceElement.innerHTML = `${data.newBalance} <div class="coin-icon"></div>`;
      }

      alert(`✅ Voucher created!\n${data.voucher.redeemUrl}`);
    } catch (err) {
      hideLoading();
      console.error("BUY error:", err);
      alert("Network error buying reward.");
    }
  });

  // Start camera if scan view is active
  const scanView = document.getElementById("scan-view");
  if (scanView && scanView.classList.contains("active")) startCamera();
});
