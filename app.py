import os
import sqlite3
import secrets
import hmac
import hashlib
import urllib.parse
from datetime import datetime

import requests
from flask import Flask, request, jsonify, g
from flask_cors import CORS

import io
import qrcode


app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
DB_PATH = os.path.join(INSTANCE_DIR, "rubi_trail.db")

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()


# ------------------------------------------------------------
# Telegram helpers (verify initData)
# ------------------------------------------------------------
def verify_telegram_init_data(init_data: str, bot_token: str):
    """
    Verifies Telegram Mini App initData.
    Returns dict of parsed values if valid, otherwise None.
    """
    if not init_data or not bot_token:
        return None

    # initData is like: "query_id=...&user=...&auth_date=...&hash=..."
    parsed = urllib.parse.parse_qs(init_data, strict_parsing=False)
    # parse_qs gives lists
    data = {k: v[0] for k, v in parsed.items()}

    received_hash = data.pop("hash", None)
    if not received_hash:
        return None

    # Create data_check_string
    pairs = []
    for k in sorted(data.keys()):
        pairs.append(f"{k}={data[k]}")
    data_check_string = "\n".join(pairs)

    secret_key = hmac.new(
        key=b"WebAppData",
        msg=bot_token.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).digest()

    calculated_hash = hmac.new(
        key=secret_key,
        msg=data_check_string.encode("utf-8"),
        digestmod=hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(calculated_hash, received_hash):
        return None

    return data


def telegram_send_message(chat_id: str, text: str) -> bool:
    if not TELEGRAM_BOT_TOKEN:
        print("TELEGRAM_BOT_TOKEN missing -> cannot send")
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        r = requests.post(url, json={"chat_id": chat_id, "text": text}, timeout=10)
        if r.status_code != 200:
            print("sendMessage failed:", r.status_code, r.text)
            return False
        return True
    except Exception as e:
        print("sendMessage exception:", repr(e))
        return False


def telegram_send_photo(chat_id: str, caption: str, png_bytes: bytes) -> bool:
    if not TELEGRAM_BOT_TOKEN:
        print("TELEGRAM_BOT_TOKEN missing -> cannot send")
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"
    try:
        files = {"photo": ("voucher.png", png_bytes, "image/png")}
        data = {"chat_id": chat_id, "caption": caption}
        r = requests.post(url, data=data, files=files, timeout=15)
        if r.status_code != 200:
            print("sendPhoto failed:", r.status_code, r.text)
            return False
        return True
    except Exception as e:
        print("sendPhoto exception:", repr(e))
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

    # seed rewards
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
    Secure Telegram Mini App auth.
    Expects JSON:
      { "initData": "<Telegram.WebApp.initData>" }
    Returns:
      { token, user }
    """
    data = request.get_json(silent=True) or {}
    init_data = str(data.get("initData", "")).strip()

    verified = verify_telegram_init_data(init_data, TELEGRAM_BOT_TOKEN)
    if not verified:
        return jsonify({"error": "Invalid Telegram initData"}), 401

    # user is JSON string
    user_json = verified.get("user", "")
    try:
        import json
        tg_user = json.loads(user_json)
    except Exception:
        return jsonify({"error": "Invalid user payload"}), 400

    telegram_id = str(tg_user.get("id", "")).strip()
    name = (tg_user.get("first_name") or tg_user.get("username") or "Telegram User").strip()

    if not telegram_id:
        return jsonify({"error": "Telegram user id missing"}), 400

    db = get_db()
    now = datetime.utcnow().isoformat()

    row = db.execute("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,)).fetchone()
    if row is None:
        db.execute(
            "INSERT INTO users(telegram_id, name, coins, created_at) VALUES (?, ?, ?, ?)",
            (telegram_id, name, 0, now),
        )
        db.commit()
        row = db.execute("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,)).fetchone()
    else:
        row = dict(row)
        if name and name != row["name"]:
            db.execute("UPDATE users SET name = ? WHERE telegram_id = ?", (name, telegram_id))
            db.commit()
            row = db.execute("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,)).fetchone()

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
        return jsonify({"success": False, "message": "This QR code was already scanned.", "newBalance": user["coins"], "addedCoins": 0})

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

    # refresh coins
    user_db = dict(db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone())

    if user_db["coins"] < reward["price"]:
        return jsonify({"success": False, "message": "Not enough coins", "newBalance": user_db["coins"]})

    code = secrets.token_urlsafe(8)
    now = datetime.utcnow().isoformat()

    db.execute("UPDATE users SET coins = coins - ? WHERE id = ?", (reward["price"], user_db["id"]))
    db.execute(
        "INSERT INTO vouchers(user_id, reward_id, code, created_at) VALUES (?, ?, ?, ?)",
        (user_db["id"], reward_id, code, now),
    )
    db.commit()

    new_balance = db.execute("SELECT coins FROM users WHERE id = ?", (user_db["id"],)).fetchone()["coins"]
    base_url = request.host_url.rstrip("/")
    redeem_url = f"{base_url}/voucher/{code}"

    # send both link + QR image to correct telegram_id
    tg_id = str(user_db["telegram_id"])
    caption = f"🎫 Voucher created!\nReward: {reward['title']}\nCode: {code}\nLink: {redeem_url}"

    # generate QR png
    img = qrcode.make(redeem_url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    png_bytes = buf.getvalue()

    telegram_send_photo(tg_id, caption, png_bytes)

    return jsonify({"success": True, "message": "Purchase successful!", "newBalance": new_balance, "voucher": {"code": code, "redeemUrl": redeem_url}})


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
    </head>
    <body style="font-family: system-ui; padding: 24px;">
      <div style="max-width:520px;margin:0 auto;border:1px solid #ddd;border-radius:14px;padding:18px;">
        <h2>{v["title"]}</h2>
        <p style="color:#666;">{v["description"] or ""}</p>
        <p style="font-size:22px;font-weight:800;letter-spacing:1px;">{v["code"]}</p>
        <p style="color:#666;">Created: {v["created_at"]}</p>
      </div>
    </body>
    </html>
    """


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "10000"))
    app.run(host="0.0.0.0", port=port, debug=False)
