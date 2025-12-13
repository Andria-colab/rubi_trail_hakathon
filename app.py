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
CORS(app)

app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///rubi_trail.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = "change-me-in-production"

db = SQLAlchemy(app)

# ⚠️ For real use, move this to an env var instead of hardcoding
TELEGRAM_BOT_TOKEN = "8215116214:AAH66xqQBYveDNuM3siYvmKuyP9jY5cf-rQ"


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
    name = db.Column(db.String(128), nullable=False)
    reward_coins = db.Column(db.Integer, nullable=False, default=10)
    qr_code_value = db.Column(db.String(128), unique=True, nullable=False)


class Visit(db.Model):
    __tablename__ = "visits"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    attraction_id = db.Column(db.Integer, db.ForeignKey("attractions.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


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
# TELEGRAM HELPER
# -----------------------

def send_voucher_qr_to_user(user: User, redeem_url: str):
    """
    Generate a QR for redeem_url and send it to the user's Telegram chat.
    Assumes user.telegram_id is their chat id.
    """
    if not TELEGRAM_BOT_TOKEN:
        print("No TELEGRAM_BOT_TOKEN configured, skipping Telegram send.")
        return

    if not user.telegram_id:
        print("User has no telegram_id, skipping Telegram send.")
        return

    # Generate QR image in memory
    img = qrcode.make(redeem_url)
    bio = BytesIO()
    bio.name = "voucher.png"
    img.save(bio, "PNG")
    bio.seek(0)

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"

    data = {
        "chat_id": user.telegram_id,
        "caption": f"Here is your Rubi Trail voucher 🎟\n{redeem_url}",
    }
    files = {
        "photo": bio,
    }

    resp = requests.post(url, data=data, files=files)
    if not resp.ok:
        print("Failed to send voucher via Telegram:", resp.status_code, resp.text)
    else:
        print("Voucher sent to Telegram user", user.telegram_id)


# -----------------------
# HELPER FUNCTIONS
# -----------------------

def get_current_user():
    """
    Super simplified 'auth':
    Expect header: X-User-Id: <user_id>
    OR Authorization: Bearer <user_id>
    """
    user_id = None

    auth = request.headers.get("Authorization")
    if auth and auth.startswith("Bearer "):
        try:
            user_id = int(auth.split(" ")[1])
        except ValueError:
            pass

    if user_id is None:
        header_id = request.headers.get("X-User-Id")
        if header_id:
            try:
                user_id = int(header_id)
            except ValueError:
                pass

    if user_id is None:
        return None

    return User.query.get(user_id)


def create_demo_data():
    """Create demo DB with one user, some attractions, services, and rewards."""
    db.drop_all()
    db.create_all()

    # Demo user – telegram_id set to your chat id for testing
    user = User(telegram_id="6732377993", name="Demo User", coins=50)
    db.session.add(user)

    # Attractions
    a1 = Attraction(
        name="Ali and Nino",
        reward_coins=20,
        qr_code_value="https://rubi.attractions/a/1"
    )
    a2 = Attraction(
        name="Flame Towers",
        reward_coins=15,
        qr_code_value="https://rubi.attractions/a/2"
    )
    a3 = Attraction(
        name="Maiden Tower",
        reward_coins=25,
        qr_code_value="https://rubi.attractions/a/3"
    )

    db.session.add_all([a1, a2, a3])

    # Services (restaurants)
    s1 = Service(
        name="Tavaduri",
        logo_url="https://via.placeholder.com/100x100.png?text=Tavaduri",
        description="Cozy restaurant with traditional food."
    )
    s2 = Service(
        name="Art House Cafe",
        logo_url="https://via.placeholder.com/100x100.png?text=Art+House",
        description="Artistic cafe with desserts and coffee."
    )
    db.session.add_all([s1, s2])
    db.session.flush()

    # Rewards
    r1 = Reward(
        service_id=s1.id,
        title="Tavaduri 20% Cashback",
        description="20% cashback on total bill, max 40 GEL.",
        price_coins=20
    )
    r2 = Reward(
        service_id=s2.id,
        title="Art House 15% Cashback",
        description="15% cashback on total bill, max 30 GEL.",
        price_coins=15
    )
    db.session.add_all([r1, r2])

    db.session.commit()
    print("Demo data created. Demo User ID:", user.id)


# -----------------------
# ROUTES
# -----------------------

@app.route("/init-db")
def init_db_route():
    """DEV ONLY: Reset and seed DB with demo data."""
    create_demo_data()
    return "Database initialized with demo data."


# ---- AUTH (SIMPLIFIED) ----

@app.route("/auth/telegram", methods=["POST"])
def auth_telegram():
    """
    Simplified auth endpoint.
    Expected JSON: { "telegram_id": "12345", "name": "User Name" }
    """
    data = request.get_json() or {}
    telegram_id = data.get("telegram_id")
    name = data.get("name", "")

    if not telegram_id:
        return jsonify({"error": "telegram_id required"}), 400

    user = User.query.filter_by(telegram_id=telegram_id).first()
    if not user:
        user = User(telegram_id=telegram_id, name=name, coins=0)
        db.session.add(user)
        db.session.commit()

    # Our "token" is just the user id for now.
    return jsonify({
        "token": str(user.id),
        "user": {
            "id": user.id,
            "name": user.name,
            "coins": user.coins
        }
    })


# ---- ATTRACTION SCAN ----

@app.route("/api/attractions/scan", methods=["POST"])
def scan_attraction():
    user = get_current_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json() or {}
    code = data.get("code")
    if not code:
        return jsonify({"success": False, "message": "No QR code provided"}), 400

    attraction = Attraction.query.filter_by(qr_code_value=code).first()
    if not attraction:
        return jsonify({"success": False, "message": "Invalid QR code"}), 404

    # Check if user already visited
    existing_visit = Visit.query.filter_by(
        user_id=user.id,
        attraction_id=attraction.id
    ).first()

    if existing_visit:
        return jsonify({
            "success": False,
            "message": "You already claimed this spot."
        })

    # Grant coins, record visit
    user.coins += attraction.reward_coins
    visit = Visit(user_id=user.id, attraction_id=attraction.id)
    db.session.add(visit)
    db.session.commit()

    return jsonify({
        "success": True,
        "message": f"You discovered {attraction.name}!",
        "addedCoins": attraction.reward_coins,
        "newBalance": user.coins
    })


# ---- LIST REWARDS ----

@app.route("/api/rewards", methods=["GET"])
def list_rewards():
    user = get_current_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401

    rewards = Reward.query.all()
    result = []
    for r in rewards:
        result.append({
            "id": r.id,
            "title": r.title,
            "description": r.description,
            "priceCoins": r.price_coins,
            "service": {
                "id": r.service.id,
                "name": r.service.name,
                "logoUrl": r.service.logo_url,
                "description": r.service.description
            }
        })
    return jsonify({
        "rewards": result,
        "userCoins": user.coins
    })


# ---- BUY REWARD → CREATE VOUCHER ----

@app.route("/api/rewards/<int:reward_id>/buy", methods=["POST"])
def buy_reward(reward_id):
    user = get_current_user()
    if not user:
        return jsonify({"error": "Unauthorized"}), 401

    reward = Reward.query.get(reward_id)
    if not reward:
        return jsonify({"success": False, "message": "Reward not found"}), 404

    if user.coins < reward.price_coins:
        return jsonify({
            "success": False,
            "message": "Not enough coins.",
            "currentCoins": user.coins
        }), 400

    # Deduct coins
    user.coins -= reward.price_coins

    # Create voucher
    token = secrets.token_urlsafe(16)
    voucher = Voucher(
        user_id=user.id,
        reward_id=reward.id,
        service_id=reward.service_id,
        redeem_token=token,
        status="ACTIVE"
    )
    db.session.add(voucher)
    db.session.commit()

    # Build redeem URL (web page waitress will open)
    redeem_url = f"http://127.0.0.1:5000/v/{token}"

    # 🔥 Send QR via Telegram
    try:
        send_voucher_qr_to_user(user, redeem_url)
    except Exception as e:
        print("Error sending Telegram QR:", e)

    return jsonify({
        "success": True,
        "message": "Voucher created.",
        "newBalance": user.coins,
        "voucher": {
            "id": voucher.id,
            "redeemUrl": redeem_url,
            "rewardTitle": reward.title,
            "serviceName": reward.service.name
        }
    })


# ---- PUBLIC VOUCHER PAGE (/v/<token>) ----

VOUCHER_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Rubi Voucher</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background: #f4f5f7;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
        }
        .card {
            background: #ffffff;
            padding: 24px;
            border-radius: 16px;
            max-width: 360px;
            width: 100%;
            box-shadow: 0 4px 16px rgba(0,0,0,0.08);
            text-align: center;
        }
        .logo {
            width: 80px;
            height: 80px;
            border-radius: 16px;
            object-fit: cover;
            margin-bottom: 16px;
        }
        .title {
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 8px;
        }
        .service-name {
            font-size: 16px;
            font-weight: 600;
            color: #e53935;
            margin-bottom: 8px;
        }
        .desc {
            font-size: 14px;
            color: #555;
            margin-bottom: 20px;
        }
        .btn {
            background: #e53935;
            color: #fff;
            border: none;
            border-radius: 999px;
            padding: 12px 24px;
            font-size: 14px;
            font-weight: 700;
            cursor: pointer;
            width: 100%;
        }
        .btn:active {
            transform: scale(0.98);
        }
        .status {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 12px;
        }
        .status--invalid {
            color: #b71c1c;
        }
        .status--valid {
            color: #1b5e20;
        }
    </style>
</head>
<body>
    <div class="card">
        {% if invalid %}
            <div class="status status--invalid">Voucher invalid or already redeemed.</div>
            <div class="desc">Ask the customer to show a different voucher or contact support.</div>
        {% else %}
            {% if service.logo_url %}
                <img src="{{ service.logo_url }}" alt="{{ service.name }}" class="logo">
            {% endif %}
            <div class="service-name">{{ service.name }}</div>
            <div class="title">{{ reward.title }}</div>
            <div class="desc">{{ reward.description }}</div>

            <div id="status-box" class="status"></div>
            <button id="redeem-btn" class="btn">Redeem now</button>
        {% endif %}
    </div>

    {% if not invalid %}
    <script>
        const token = "{{ token }}";
        const statusBox = document.getElementById("status-box");
        const btn = document.getElementById("redeem-btn");

        btn.addEventListener("click", async () => {
            btn.disabled = true;
            btn.textContent = "Processing...";
            statusBox.textContent = "";

            try {
                const res = await fetch("/api/vouchers/redeem", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token })
                });
                const data = await res.json();
                if (data.success) {
                    statusBox.textContent = "Voucher redeemed successfully ✅";
                    statusBox.className = "status status--valid";
                    btn.style.display = "none";
                } else {
                    statusBox.textContent = data.message || "Voucher invalid.";
                    statusBox.className = "status status--invalid";
                    btn.style.display = "none";
                }
            } catch (err) {
                statusBox.textContent = "Network error. Try again.";
                statusBox.className = "status status--invalid";
                btn.disabled = false;
                btn.textContent = "Redeem now";
            }
        });
    </script>
    {% endif %}
</body>
</html>
"""


@app.route("/v/<token>")
def voucher_page(token):
    voucher = Voucher.query.filter_by(redeem_token=token).first()
    if not voucher or voucher.status != "ACTIVE":
        return render_template_string(VOUCHER_TEMPLATE, invalid=True)

    return render_template_string(
        VOUCHER_TEMPLATE,
        invalid=False,
        token=token,
        reward=voucher.reward,
        service=voucher.service
    )


# ---- REDEEM VOUCHER API (called from voucher page) ----

@app.route("/api/vouchers/redeem", methods=["POST"])
def redeem_voucher():
    data = request.get_json() or {}
    token = data.get("token")
    if not token:
        return jsonify({"success": False, "message": "Missing token"}), 400

    voucher = Voucher.query.filter_by(redeem_token=token).first()
    if not voucher:
        return jsonify({"success": False, "message": "Voucher not found"}), 404

    if voucher.status != "ACTIVE":
        return jsonify({"success": False, "message": "Voucher already redeemed"}), 400

    voucher.status = "REDEEMED"
    voucher.redeemed_at = datetime.utcnow()
    db.session.commit()

    return jsonify({"success": True, "message": "Voucher redeemed successfully"})


# -----------------------
# MAIN ENTRY POINT
# -----------------------

if __name__ == "__main__":
    app.run(debug=True)
