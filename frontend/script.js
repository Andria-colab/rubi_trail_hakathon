console.log("🔥 FRONTEND SCRIPT LOADED");

const API_BASE = "https://rubi-trail-hakathon.onrender.com";

let authToken = null; // this will be our "user id" from backend

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
    if (!scanning) return;

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
                console.log("QR payload:", JSON.stringify(code.data));
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
    if (!authToken) {
        alert("Not authenticated yet. Try reloading the page.");
        return;
    }

    showLoading();
    try {
        const res = await fetch(`${API_BASE}/api/attractions/scan`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({ code: decodedText })
        });

        const data = await res.json();
        hideLoading();

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

document.addEventListener("DOMContentLoaded", () => {
    initAuth();

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

window.addEventListener("backend-qr-code", e => {
    const qrString = e.detail; // e.g., "SOME_QR_DATA"
    renderQRCodeFromBackend(qrString);
});
