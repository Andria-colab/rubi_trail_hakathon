import os
import sqlite3
import secrets
from datetime import datetime
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

    # Seed rewards (matching your frontend IDs 1..3)
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
    cur = db.execute("SELECT * FROM users WHERE id = ?", (int(token),))
    return cur.fetchone()


# ------------------------------------------------------------
# Routes
# ------------------------------------------------------------
@app.get("/")
def home():
    return jsonify({"ok": True, "service": "rubi-trail-backend"})


@app.post("/auth/telegram")
def auth_telegram():
    """
    Expects JSON:
      { "telegram_id": "...", "name": "..." }
    Returns:
      { "token": "<user_id>", "user": { "id":..., "coins":... } }
    """
    data = request.get_json(silent=True) or {}
    telegram_id = str(data.get("telegram_id", "")).strip()
    name = str(data.get("name", "")).strip()

    if not telegram_id:
        return jsonify({"error": "telegram_id is required"}), 400

    db = get_db()
    now = datetime.utcnow().isoformat()

    # Upsert user
    cur = db.execute("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,))
    row = cur.fetchone()

    if row is None:
        db.execute(
            "INSERT INTO users(telegram_id, name, coins, created_at) VALUES (?, ?, ?, ?)",
            (telegram_id, name or "User", 0, now),
        )
        db.commit()
        user_id = db.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    else:
        # keep existing coins, update name if provided
        if name and name != row["name"]:
            db.execute("UPDATE users SET name = ? WHERE id = ?", (name, row["id"]))
            db.commit()
            row = db.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()

    return jsonify(
        {
            "token": str(row["id"]),
            "user": {"id": row["id"], "name": row["name"], "coins": row["coins"]},
        }
    )


@app.get("/api/me")
def api_me():
    user = require_user()
    if user is None:
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"id": user["id"], "name": user["name"], "coins": user["coins"]})


@app.post("/api/attractions/scan")
def scan_attraction():
    """
    Expects JSON:
      { "qrText": "..." }
    Uses Authorization: Bearer <token>
    Returns:
      { success, message, newBalance, addedCoins }
    """
    user = require_user()
    if user is None:
        return jsonify({"success": False, "message": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    qr_text = str(data.get("qrText", "")).strip()

    if not qr_text:
        return jsonify({"success": False, "message": "qrText is required"}), 400

    db = get_db()
    now = datetime.utcnow().isoformat()

    # Prevent double-scan same QR for same user
    try:
        db.execute(
            "INSERT INTO scans(user_id, qr_text, scanned_at) VALUES (?, ?, ?)",
            (user["id"], qr_text, now),
        )
    except sqlite3.IntegrityError:
        # already scanned
        return jsonify(
            {
                "success": False,
                "message": "This QR code was already scanned.",
                "newBalance": user["coins"],
                "addedCoins": 0,
            }
        )

    # Reward coins (simple rule: +10 per new QR)
    added = 10
    db.execute("UPDATE users SET coins = coins + ? WHERE id = ?", (added, user["id"]))
    db.commit()

    new_coins = db.execute("SELECT coins FROM users WHERE id = ?", (user["id"],)).fetchone()["coins"]

    return jsonify(
        {
            "success": True,
            "message": f"Scan accepted! +{added} coins",
            "newBalance": new_coins,
            "addedCoins": added,
        }
    )


@app.post("/api/rewards/<int:reward_id>/buy")
def buy_reward(reward_id: int):
    """
    Uses Authorization: Bearer <token>
    Returns:
      { success, message, newBalance, voucher: { code, redeemUrl } }
    """
    user = require_user()
    if user is None:
        return jsonify({"success": False, "message": "Unauthorized"}), 401

    db = get_db()
    reward = db.execute("SELECT * FROM rewards WHERE id = ?", (reward_id,)).fetchone()
    if reward is None:
        return jsonify({"success": False, "message": "Reward not found"}), 404

    if user["coins"] < reward["price"]:
        return jsonify(
            {
                "success": False,
                "message": "Not enough coins",
                "newBalance": user["coins"],
            }
        )

    # Deduct coins
    db.execute("UPDATE users SET coins = coins - ? WHERE id = ?", (reward["price"], user["id"]))

    # Create voucher
    code = secrets.token_urlsafe(8)
    now = datetime.utcnow().isoformat()
    db.execute(
        "INSERT INTO vouchers(user_id, reward_id, code, created_at) VALUES (?, ?, ?, ?)",
        (user["id"], reward_id, code, now),
    )
    db.commit()

    new_balance = db.execute("SELECT coins FROM users WHERE id = ?", (user["id"],)).fetchone()["coins"]

    base_url = request.host_url.rstrip("/")
    redeem_url = f"{base_url}/voucher/{code}"

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

    # Simple HTML page (Render-friendly)
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


# ------------------------------------------------------------
# Local dev / Render fallback (Render mainly uses gunicorn)
# ------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", "10000"))
    app.run(host="0.0.0.0", port=port, debug=False)
