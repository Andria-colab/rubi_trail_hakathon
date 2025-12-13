import os
import secrets
from datetime import datetime
from io import BytesIO

import qrcode
import requests
from flask import Flask, request, jsonify, render_template_string
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS


# -----------------------
# BASIC FLASK SETUP
# -----------------------
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, "instance", "rubi_trail.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///" + DB_PATH
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "change-me-in-production")

db = SQLAlchemy(app)

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()


# -----------------------
# DATABASE MODELS
# -----------------------
class User(db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    telegram_id = db.Column(db.String(64), unique=True, nullable=False)
    name = db.Column(db.String(128))
    coins = db.Column(db.Integer, default=0)


class Attraction(db.Model):
    __tablename__ = "attractions"
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False)
    description = db.Column(db.Text)
    address = db.Column(db.Text)
    lat = db.Column(db.Float)
    lon = db.Column(db.Float)
    reward_coins = db.Column(db.Integer, nullable=False, default=10)
    qr_code_value = db.Column(db.String(255), unique=True, nullable=False)


class Visit(db.Model):
    __tablename__ = "visits"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    attraction_id = db.Column(db.Integer, db.ForeignKey("attractions.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    __table_args__ = (
        db.UniqueConstraint("user_id", "attraction_id", name="uq_user_attraction"),
    )


class Service(db.Model):
    __tablename__ = "services"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(128), nullable=False)
    logo_url = db.Column(db.String(256))
    description = db.Column(db.String(256))


class Reward(db.Model):
    __tablename__ = "rewards"
    id = db.Column(db.Integer, primary_key=True)
    service_id = db.Column(db.Integer, db.ForeignKey("services.id"), nullable=False)
    title = db.Column(db.String(128), nullable=False)
    description = db.Column(db.String(256))
    price_coins = db.Column(db.Integer, nullable=False)

    service = db.relationship("Service", backref="rewards")


class Voucher(db.Model):
    __tablename__ = "vouchers"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    reward_id = db.Column(db.Integer, db.ForeignKey("rewards.id"), nullable=False)
    service_id = db.Column(db.Integer, db.ForeignKey("services.id"), nullable=False)

    redeem_token = db.Column(db.String(64), unique=True, nullable=False)
    status = db.Column(db.String(16), nullable=False, default="ACTIVE")  # ACTIVE / REDEEMED
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    redeemed_at = db.Column(db.DateTime)

    user = db.relationship("User", backref="vouchers")
    reward = db.relationship("Reward", backref="vouchers")
    service = db.relationship("Service", backref="vouchers")


# -----------------------
# TELEGRAM HELPERS (from your sqlite version)
# -----------------------
def send_telegram_message(chat_id: str, text: str) -> bool:
    if not TELEGRAM_BOT_TOKEN:
        print("TELEGRAM_BOT_TOKEN is not set -> skipping telegram message")
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        resp = requests.post(
            url,
            json={"chat_id": chat_id, "text": text, "disable_web_page_preview": False},
            timeout=10,
        )
        if resp.status_code != 200:
            print("Telegram send failed:", resp.status_code, resp.text)
            return False
        return True
    except Exception as e:
        print("Telegram send exception:", repr(e))
        return False


def send_telegram_qr(chat_id: str, caption: str, qr_payload: str) -> bool:
    if not TELEGRAM_BOT_TOKEN:
        print("TELEGRAM_BOT_TOKEN is not set -> skipping QR send")
        return False

    img = qrcode.make(qr_payload)
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"
    try:
        r = requests.post(
            url,
            data={"chat_id": chat_id, "caption": caption},
            files={"photo": ("voucher.png", buf, "image/png")},
            timeout=15,
        )
        if r.status_code != 200:
            print("Telegram sendPhoto error:", r.text)
            return False
        return True
    except Exception as e:
        print("Telegram sendPhoto exception:", repr(e))
        return False


# -----------------------
# AUTH (matches your frontend: Bearer <user_id>)
# -----------------------
def get_current_user():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth.split(" ", 1)[1].strip()
        if token.isdigit():
            return User.query.get(int(token))
    return None


# -----------------------
# OPTIONAL: init/seed (your create_demo_data, but safer)
# -----------------------
def create_demo_data():
    db.drop_all()
    db.create_all()

    # Demo user (change telegram_id for YOUR account if you want to test DM)
    user = User(telegram_id="6732377993", name="Demo User", coins=0)
    db.session.add(user)

    # Attractions
    a1 = Attraction(
        title="Ali and Nino",
        description="Batumi Boulevard attraction.",
        address="Batumi Boulevard",
        lat=41.6539,
        lon=41.6360,
        reward_coins=10,
        qr_code_value="AliAndNiNoVisit27",
    )
    a2 = Attraction(
        title="Alphabetic Tower",
        description="Batumi Boulevard attraction.",
        address="Batumi Boulevard",
        lat=41.656088567441216,
        lon=41.639600470801206,
        reward_coins=10,
        qr_code_value="AliAndNiNoVisit90",
    )
    a3 = Attraction(
        title="GITA TouristHack 2025",
        description="Tech Park Batumi attraction.",
        address="Tech Park Batumi",
        lat=41.62386745993197,
        lon=41.62490440795824,
        reward_coins=10,
        qr_code_value="AliAndNiNoVisit72",
    )
    db.session.add_all([a1, a2, a3])

    # Services
    s1 = Service(name="Tavaduri", logo_url="", description="Cozy restaurant.")
    s2 = Service(name="Art House Cafe", logo_url="", description="Cafe.")
    s3 = Service(name="Museum of Arts", logo_url="", description="Museum.")
    db.session.add_all([s1, s2, s3])
    db.session.flush()

    # Rewards
    r1 = Reward(service_id=s1.id, title="Tavaduri 20% Cashback", description="Max 40 GEL", price_coins=20)
    r2 = Reward(service_id=s2.id, title="Art House 15% Cashback", description="Max 30 GEL", price_coins=15)
    r3 = Reward(service_id=s3.id, title="Free entrance", description="Free entry", price_coins=10)
    db.session.add_all([r1, r2, r3])

    db.session.commit()
    print("✅ Demo data created. Demo User ID:", user.id)


# -----------------------
# ROUTES
# -----------------------
@app.get("/")
def home():
    return jsonify({"ok": True, "service": "rubi-trail-backend"})


@app.get("/health")
def health():
    return jsonify({"status": "ok"}), 200


@app.get("/init-db")
def init_db_route():
    create_demo_data()
    return "Database initialized with demo data."


@app.post("/auth/telegram")
def auth_telegram():
    data = request.get_json(silent=True) or {}
    telegram_id = str(data.get("telegram_id", "")).strip()
    name = str(data.get("name", "")).strip()

    if not telegram_id:
        return jsonify({"error": "telegram_id required"}), 400

    user = User.query.filter_by(telegram_id=telegram_id).first()
    if not user:
        user = User(telegram_id=telegram_id, name=name or "User", coins=0)
        db.session.add(user)
        db.session.commit()
    else:
        if name and name != (user.name or ""):
            user.name = name
            db.session.commit()

    return jsonify({"token": str(user.id), "user": {"id": user.id, "name": user.name, "coins": user.coins}})


@app.get("/api/me")
def api_me():
    user = get_current_user()
    if not user:
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"id": user.id, "name": user.name, "coins": user.coins})


@app.post("/api/attractions/scan")
def scan_attraction():
    user = get_current_user()
    if not user:
        return jsonify({"success": False, "message": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}

    # ✅ Accept BOTH keys so your frontend + old code both work
    qr_value = (data.get("qrText") or data.get("code") or "").strip()
    if not qr_value:
        return jsonify({"success": False, "message": "No QR code provided"}), 400

    attraction = Attraction.query.filter_by(qr_code_value=qr_value).first()
    if not attraction:
        return jsonify({"success": False, "message": "Invalid QR code"}), 404

    existing = Visit.query.filter_by(user_id=user.id, attraction_id=attraction.id).first()
    if existing:
        return jsonify({"success": False, "message": "You already claimed this spot.", "newBalance": user.coins, "addedCoins": 0})

    user.coins += attraction.reward_coins
    db.session.add(Visit(user_id=user.id, attraction_id=attraction.id))
    db.session.commit()

    return jsonify({
        "success": True,
        "message": f"You discovered {attraction.title}!",
        "addedCoins": attraction.reward_coins,
        "newBalance": user.coins
    })


@app.get("/api/rewards")
def list_rewards():
    user = get_current_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401

    rewards = Reward.query.all()
    return jsonify({
        "userCoins": user.coins,
        "rewards": [
            {
                "id": r.id,
                "title": r.title,
                "description": r.description,
                "priceCoins": r.price_coins,
                "service": {
                    "id": r.service.id,
                    "name": r.service.name,
                    "logoUrl": r.service.logo_url,
                    "description": r.service.description,
                },
            }
            for r in rewards
        ],
    })


@app.post("/api/rewards/<int:reward_id>/buy")
def buy_reward(reward_id: int):
    user = get_current_user()
    if not user:
        return jsonify({"success": False, "message": "Unauthorized"}), 401

    reward = Reward.query.get(reward_id)
    if not reward:
        return jsonify({"success": False, "message": "Reward not found"}), 404

    if user.coins < reward.price_coins:
        return jsonify({"success": False, "message": "Not enough coins.", "newBalance": user.coins}), 400

    # Deduct + create voucher
    user.coins -= reward.price_coins
    token = secrets.token_urlsafe(16)
    voucher = Voucher(
        user_id=user.id,
        reward_id=reward.id,
        service_id=reward.service_id,
        redeem_token=token,
        status="ACTIVE",
    )
    db.session.add(voucher)
    db.session.commit()

    # ✅ Render-safe redeem URL (no localhost)
    base_url = request.host_url.rstrip("/")
    redeem_url = f"{base_url}/v/{token}"

    # ✅ Send QR + also send text fallback
    caption = f"🎫 Your Rubi Trail voucher\n{reward.title}\n\nOpen: {redeem_url}"
    sent_qr = send_telegram_qr(user.telegram_id, caption, redeem_url)
    if not sent_qr:
        send_telegram_message(user.telegram_id, caption)

    return jsonify({
        "success": True,
        "message": "Voucher created.",
        "newBalance": user.coins,
        "voucher": {
            "id": voucher.id,
            "redeemUrl": redeem_url,
            "rewardTitle": reward.title,
            "serviceName": reward.service.name,
        }
    })


# ---- PUBLIC VOUCHER PAGE (/v/<token>) ----
VOUCHER_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Rubi Voucher</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f4f5f7;">
  <div style="background:white;padding:24px;border-radius:16px;max-width:420px;width:100%;text-align:center;">
    {% if invalid %}
      <h2>Voucher invalid or already redeemed.</h2>
    {% else %}
      <h2>{{ service.name }}</h2>
      <h3>{{ reward.title }}</h3>
      <p>{{ reward.description }}</p>
      <p><b>Status:</b> {{ voucher.status }}</p>
      <button id="redeem-btn" style="padding:12px 24px;border-radius:999px;border:none;background:#e53935;color:white;font-weight:700;cursor:pointer;">
        Redeem now
      </button>
      <p id="msg"></p>
      <script>
        const token = "{{ token }}";
        const btn = document.getElementById("redeem-btn");
        const msg = document.getElementById("msg");
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = "Processing...";
          const res = await fetch("/api/vouchers/redeem", {
            method: "POST",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({ token })
          });
          const data = await res.json();
          msg.textContent = data.success ? "Redeemed ✅" : (data.message || "Invalid");
          btn.style.display = "none";
        });
      </script>
    {% endif %}
  </div>
</body>
</html>
"""


@app.get("/v/<token>")
def voucher_page(token: str):
    v = Voucher.query.filter_by(redeem_token=token).first()
    if not v or v.status != "ACTIVE":
        return render_template_string(VOUCHER_TEMPLATE, invalid=True)

    return render_template_string(
        VOUCHER_TEMPLATE,
        invalid=False,
        token=token,
        voucher=v,
        reward=v.reward,
        service=v.service,
    )


@app.post("/api/vouchers/redeem")
def redeem_voucher():
    data = request.get_json(silent=True) or {}
    token = (data.get("token") or "").strip()
    if not token:
        return jsonify({"success": False, "message": "Missing token"}), 400

    v = Voucher.query.filter_by(redeem_token=token).first()
    if not v:
        return jsonify({"success": False, "message": "Voucher not found"}), 404
    if v.status != "ACTIVE":
        return jsonify({"success": False, "message": "Voucher already redeemed"}), 400

    v.status = "REDEEMED"
    v.redeemed_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"success": True, "message": "Voucher redeemed successfully"})


# -----------------------
# MAIN ENTRY POINT
# -----------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", "10000"))
    app.run(host="0.0.0.0", port=port, debug=False)
