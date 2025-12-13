import os
import io
import hmac
import json
import hashlib
import sqlite3
import secrets
from datetime import datetime
from urllib.parse import parse_qsl

import qrcode
import requests
from flask import Flask, request, jsonify, g
from flask_cors import CORS


# ------------------------------------------------------------
# App setup
# ------------------------------------------------------------
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
DB_PATH = os.path.join(INSTANCE_DIR, "rubi_trail.db")

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()


# ------------------------------------------------------------
# Telegram WebApp initData verification
# ------------------------------------------------------------
def verify_telegram_webapp_init_data(init_data: str) -> dict | None:
    """
    Verifies Telegram WebApp initData signature.
    Returns parsed dict (with "user" etc) if valid, else None.
    """
    if not TELEGRAM_BOT_TOKEN:
        return None
    if not init_data:
        return None

    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    data_check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs.keys()))

    secret_key = hashlib.sha256(TELEGRAM_BOT_TOKEN.encode("utf-8")).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calculated_hash, received_hash):
        return None

    # Parse JSON fields
    if "user" in pairs:
        try:
            pairs["user"] = json.loads(pairs["user"])
        except Exception:
            pass

    return pairs


# ------------------------------------------------------------
# Telegram helpers
# ------------------------------------------------------------
def telegram_send_message(chat_id: str, text: str) -> bool:
    if not TELEGRAM_BOT_TOKEN:
        print("TELEGRAM_BOT_TOKEN not set -> skipping telegram message")
        return False
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        resp = requests.post(
            url,
            json={"chat_id": chat_id, "text": text, "disable_web_page_preview": False},
            timeout=10,
        )
        if resp.status_code != 200:
            print("Telegram sendMessage failed:", resp.status_code, resp.text)
            return False
        return True
    except Exception as e:
        print("Telegram sendMessage exception:", repr(e))
        return False


def telegram_send_qr_photo(chat_id: str, redeem_url: str, caption: str) -> bool:
    """
    Generates a QR code PNG for redeem_url and sends it via Telegram sendPhoto.
    """
    if not TELEGRAM_BOT_TOKEN:
        print("TELEGRAM_BOT_TOKEN not set -> skipping telegram photo")
        return False

    img = qrcode.make(redeem_url)
    bio = io.BytesIO()
    img.save(bio, format="PNG")
    bio.seek(0)

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"
    try:
        resp = requests.post(
            url,
            data={"chat_id": chat_id, "caption": caption},
            files={"photo": ("voucher.png", bio, "image/png")},
            timeout=15,
        )
        if resp.status_code != 200:
            print("Telegram sendPhoto failed:", resp.status_code, resp.text)
            return False
        return True
    except Exception as e:
        print("Telegram sendPhoto exception:", repr(e))
        return False


# ------------------------------------------------------------
# DB helpers
# ------------------------------------------------------------
def get_db():
    if "db" not in g:
        os.makedirs(INSTANCE_DIR, exist_ok=True)
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_err):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = get_db()

    db.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id TEXT UNIQUE NOT NULL,
            name TEXT,
            coins INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
        """
    )

    db.execute(
        """
        CREATE TABLE IF NOT EXISTS scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            qr_text TEXT NOT NULL,
            scanned_at TEXT NOT NULL,
            UNIQUE(user_id, qr_text),
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
        """
    )

    db.execute(
        """
        CREATE TABLE IF NOT EXISTS rewards (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            price INTEGER NOT NULL,
            description TEXT
        )
        """
    )

    db.execute(
        """
        CREATE TABLE IF NOT EXISTS vouchers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reward_id INTEGER NOT NULL,
            code TEXT UNIQUE NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(reward_id) REFERENCES rewards(id)
        )
        """
    )

    # seed once
    cur = db.execute("SELECT COUNT(*) AS c FROM rewards")
    if cur.fetchone()["c"] == 0:
        db.executemany(
            "INSERT INTO rewards(id, title, price, description) VALUES (?, ?, ?, ?)",
            [
                (1, "Restaurant : Tavaduri", 20, "20% CASHBACK (MAX 40 LARI)"),
                (2, "Cafe : Art House", 15, "15% CASHBACK (MAX 30 LARI)"),
                (3, "Museum : Modern Art", 10, "FREE ENTRY + 10% CASHBACK"),
            ],
        )

    db.commit()


@app.before_request
def _before():
    init_db()


# ------------------------------------------------------------
# Auth helpers
# ------------------------------------------------------------
def get_bearer_token():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth.replace("Bearer ", "", 1).strip()
    return None


def require_user():
    token = get_bearer_token()
    if not token or not token.isdigit():
        return None
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE id = ?", (int(token),)).fetchone()
    return dict(row) if row else None


# ------------------------------------------------------------
# Routes
# ------------------------------------------------------------
@app.get("/")
def home():
    return jsonify({"ok": True, "service": "rubi-trail-backend"})


@app.post("/auth/telegram")
def auth_telegram():
    """
    Telegram Mini App auth.
    Expects JSON:
      { "initData": "<Telegram.WebApp.initData>" }
    Returns:
      { "token": "<user_id>", "user": { id, name, coins } }
    """
    data = request.get_json(silent=True) or {}
    init_data = str(data.get("initData", "")).strip()

    verified = verify_telegram_webapp_init_data(init_data)
    if verified is None:
        return jsonify({"error": "Invalid Telegram initData (signature check failed)"}), 401

    user_obj = verified.get("user") or {}
    tg_id = user_obj.get("id")
    if not tg_id:
        return jsonify({"error": "Telegram user missing in initData"}), 400

    name = (
        user_obj.get("first_name")
        or user_obj.get("username")
        or "Telegram User"
    )

    db = get_db()
    now = datetime.utcnow().isoformat()

    row = db.execute("SELECT * FROM users WHERE telegram_id = ?", (str(tg_id),)).fetchone()

    if row is None:
        db.execute(
            "INSERT INTO users(telegram_id, name, coins, created_at) VALUES (?, ?, ?, ?)",
            (str(tg_id), name, 0, now),
        )
        db.commit()
        user_id = db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    else:
        row = dict(row)
        if name and name != row["name"]:
            db.execute("UPDATE users SET name = ? WHERE id = ?", (name, row["id"]))
            db.commit()
        row = db.execute("SELECT * FROM users WHERE telegram_id = ?", (str(tg_id),)).fetchone()

    row = dict(row)
    return jsonify({"token": str(row["id"]), "user": {"id": row["id"], "name": row["name"], "coins": row["coins"]}})


@app.post("/api/attractions/scan")
def scan_attraction():
    user = require_user()
    if user is None:
        return jsonify({"success": False, "message": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    qr_text = str(data.get("qrText", "")).strip()
    if not qr_text:
        return jsonify({"success": False, "message": "qrText is required"}), 400

    db = get_db()
    now = datetime.utcnow().isoformat()

    try:
        db.execute(
            "INSERT INTO scans(user_id, qr_text, scanned_at) VALUES (?, ?, ?)",
            (user["id"], qr_text, now),
        )
    except sqlite3.IntegrityError:
        return jsonify(
            {
                "success": False,
                "message": "This QR code was already scanned.",
                "newBalance": user["coins"],
                "addedCoins": 0,
            }
        )

    added = 10
    db.execute("UPDATE users SET coins = coins + ? WHERE id = ?", (added, user["id"]))
    db.commit()

    new_coins = db.execute("SELECT coins FROM users WHERE id = ?", (user["id"],)).fetchone()["coins"]
    return jsonify({"success": True, "message": f"Scan accepted! +{added} coins", "newBalance": new_coins, "addedCoins": added})


@app.post("/api/rewards/<int:reward_id>/buy")
def buy_reward(reward_id: int):
    user = require_user()
    if user is None:
        return jsonify({"success": False, "message": "Unauthorized"}), 401

    db = get_db()
    reward_row = db.execute("SELECT * FROM rewards WHERE id = ?", (reward_id,)).fetchone()
    if reward_row is None:
        return jsonify({"success": False, "message": "Reward not found"}), 404

    reward = dict(reward_row)

    # always use latest coins
    user_db = dict(db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone())

    if user_db["coins"] < reward["price"]:
        return jsonify({"success": False, "message": "Not enough coins", "newBalance": user_db["coins"]})

    # deduct
    db.execute("UPDATE users SET coins = coins - ? WHERE id = ?", (reward["price"], user_db["id"]))

    # create voucher
    code = secrets.token_urlsafe(8)
    now = datetime.utcnow().isoformat()
    db.execute(
        "INSERT INTO vouchers(user_id, reward_id, code, created_at) VALUES (?, ?, ?, ?)",
        (user_db["id"], reward_id, code, now),
    )
    db.commit()

    new_balance = db.execute("SELECT coins FROM users WHERE id = ?", (user_db["id"],)).fetchone()["coins"]

    base_url = request.host_url.rstrip("/")
    redeem_url = f"{base_url}/voucher/{code}"

    # Send to the SAME telegram user id we verified+stored
    chat_id = str(user_db.get("telegram_id", "")).strip()
    if chat_id:
        caption = (
            f"🎫 Voucher created!\n"
            f"{reward['title']}\n"
            f"Code: {code}\n"
            f"{redeem_url}"
        )
        # Prefer QR photo
        sent = telegram_send_qr_photo(chat_id, redeem_url, caption)
        if not sent:
            telegram_send_message(chat_id, caption)

    return jsonify(
        {
            "success": True,
            "message": "Purchase successful!",
            "newBalance": new_balance,
            "voucher": {"code": code, "redeemUrl": redeem_url},
        }
    )


@app.get("/voucher/<code>")
def voucher_page(code: str):
    db = get_db()
    v = db.execute(
        """
        SELECT v.code, v.created_at, r.title, r.description
        FROM vouchers v
        JOIN rewards r ON r.id = v.reward_id
        WHERE v.code = ?
        """,
        (code,),
    ).fetchone()

    if v is None:
        return ("Voucher not found", 404)

    v = dict(v)

    return f"""
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>Voucher</title>
      <style>
        body {{ font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding: 24px; }}
        .card {{ max-width: 520px; margin: 0 auto; border: 1px solid #ddd; border-radius: 14px; padding: 18px; }}
        .code {{ font-size: 22px; font-weight: 800; letter-spacing: 1px; }}
        .muted {{ color: #666; }}
      </style>
    </head>
    <body>
      <div class="card">
        <h2>{v["title"]}</h2>
        <p class="muted">{v["description"] or ""}</p>
        <p class="code">{v["code"]}</p>
        <p class="muted">Created: {v["created_at"]}</p>
      </div>
    </body>
    </html>
    """


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "10000"))
    app.run(host="0.0.0.0", port=port, debug=False)
