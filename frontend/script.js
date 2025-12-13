console.log("🔥 FRONTEND SCRIPT LOADED");

const API_BASE = "https://rubi-trail-hakathon.onrender.com";
let authToken = null;

// ---------- AUTH ----------

async function initAuth() {
  try {
    const tg = window.Telegram?.WebApp;

    let telegramId = null;
    let displayName = "Web User";

    if (tg?.initDataUnsafe?.user?.id) {
      // ✅ Telegram mini app
      tg.ready();
      telegramId = String(tg.initDataUnsafe.user.id);
      displayName =
        tg.initDataUnsafe.user.first_name ||
        tg.initDataUnsafe.user.username ||
        "Telegram User";
    } else {
      // ✅ Fallback: open in normal browser (Render/Vercel)
      telegramId = localStorage.getItem("telegram_id_fallback");
      displayName = localStorage.getItem("telegram_name_fallback") || "Web User";

      if (!telegramId) {
        telegramId = prompt(
          "You opened this outside Telegram.\n\nEnter your TELEGRAM USER ID to continue (numbers only)."
        );
        if (!telegramId || !/^\d+$/.test(telegramId)) {
          alert("No valid Telegram ID provided. App will run in read-only mode.");
          return;
        }
        const nameInput = prompt("Optional: your name (for display)");
        if (nameInput) displayName = nameInput;

        localStorage.setItem("telegram_id_fallback", telegramId);
        localStorage.setItem("telegram_name_fallback", displayName);
      }
    }

    const res = await fetch(`${API_BASE}/auth/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        telegram_id: String(telegramId),
        name: displayName,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Auth failed response:", data);
      alert("Auth failed. Check backend logs.");
      return;
    }

    authToken = String(data.token);
    updateCoins(data.user?.coins ?? 0);
  } catch (err) {
    console.error("Auth failed:", err);
    alert("Could not connect to backend.");
  }
}

function updateCoins(coins) {
  const balanceElement = document.querySelector(".coin-balance");
  if (balanceElement) {
    balanceElement.innerHTML = `${coins} <div class="coin-icon"></div>`;
  }
}

function getAuthHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer " + authToken,
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
    document
      .querySelectorAll(".view-section")
      .forEach((v) => v.classList.remove("active"));
    document.getElementById(viewId)?.classList.add("active");

    document
      .querySelectorAll(".nav-item")
      .forEach((n) => n.classList.remove("active"));
    navElement.classList.add("active");

    if (viewId === "scan-view") startCamera();
    else stopCamera();

    hideLoading();
  }, 200);
}

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

      const imageData = qrCtx.getImageData(0, 0, w, h);
      const code = jsQR(imageData.data, w, h, { inversionAttempts: "dontInvert" });

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

// ---------- SCAN ----------

async function handleQRCode(decodedText) {
  const ok = await ensureAuth();
  if (!ok) {
    alert("Not authenticated yet. Reload.");
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
      updateCoins(data.newBalance);
      alert(`✅ ${data.message}\n+${data.addedCoins} coins`);
    } else {
      alert(`❌ ${data.message}`);
    }
  } catch (err) {
    hideLoading();
    console.error(err);
    alert("Network error during scan.");
  }
}

// ---------- BUY ----------

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
      updateCoins(data.newBalance);

      // ✅ DO NOT open voucher automatically (you wanted it in chat)
      const sent = data.telegramSent === true;

      if (sent) {
        alert(`✅ Bought: ${titleForAlert}\n📩 Voucher sent in Telegram chat!`);
      } else {
        alert(
          `✅ Bought: ${titleForAlert}\n⚠️ Could not DM you on Telegram.\nOpen the bot and press START once, then buy again.\n\nVoucher link:\n${data.voucher?.redeemUrl || ""}`
        );
      }
    } else {
      alert(`❌ ${data.message || "Could not buy reward."}`);
    }
  } catch (err) {
    hideLoading();
    console.error("Network error buying reward:", err);
    alert("Network error buying reward.");
  }
}

// ---------- LOADING ----------

function showLoading() {
  document.getElementById("loading")?.classList.add("active");
}
function hideLoading() {
  document.getElementById("loading")?.classList.remove("active");
}

// ---------- DOM READY ----------

document.addEventListener("DOMContentLoaded", async () => {
  await initAuth();

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
    const title =
      card?.querySelector(".card-reward")?.textContent?.trim() ||
      `Reward #${rewardId}`;

    buyReward(rewardId, title);
  });

  const initialScanView = document.getElementById("scan-view");
  if (initialScanView?.classList.contains("active")) {
    startCamera();
  }
});
