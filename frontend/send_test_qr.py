import qrcode
import requests
from io import BytesIO

# ----------------------------------------
# Telegram Bot Credentials
# ----------------------------------------
TELEGRAM_BOT_TOKEN = "8215116214:AAH66xqQBYveDNuM3siYvmKuyP9jY5cf-rQ"
TELEGRAM_CHAT_ID = "6732377993"   # Your chat ID

# ----------------------------------------
# Function to generate and send QR
# ----------------------------------------
def send_qr(redeem_url: str):
    # Create QR image
    img = qrcode.make(redeem_url)

    bio = BytesIO()
    bio.name = "voucher.png"
    img.save(bio, "PNG")
    bio.seek(0)

    # Telegram sendPhoto endpoint
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto"

    data = {
        "chat_id": TELEGRAM_CHAT_ID,
        "caption": f"Here is your Rubi Trail voucher 🎟\n{redeem_url}",
    }

    files = {
        "photo": bio
    }

    response = requests.post(url, data=data, files=files)

    print("Status:", response.status_code)
    print("Response:", response.text)


# ----------------------------------------
# Test run
# ----------------------------------------
if __name__ == "__main__":
    test_url = "https://example.com/test-voucher-123"
    send_qr(test_url)
