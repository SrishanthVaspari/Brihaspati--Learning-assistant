import os
import requests
import logging

logger = logging.getLogger(__name__)

class NotificationService:
    def __init__(self):
        self.telegram_bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
        self.telegram_chat_id = os.getenv("TELEGRAM_CHAT_ID")
        self.ntfy_topic = os.getenv("NTFY_TOPIC")
        self.ntfy_url = os.getenv("NTFY_URL", "https://ntfy.sh")

    def send_notification(self, message: str, title: str = "Brihaspati Alert"):
        """Send notification via configured channels."""
        success = True

        # Send to Telegram if configured
        if self.telegram_bot_token and self.telegram_chat_id:
            try:
                url = f"https://api.telegram.org/bot{self.telegram_bot_token}/sendMessage"
                payload = {
                    "chat_id": self.telegram_chat_id,
                    "text": f"*{title}*\n\n{message}",
                    "parse_mode": "Markdown"
                }
                requests.post(url, json=payload, timeout=10)
            except Exception as e:
                logger.error(f"Telegram notification failed: {e}")
                success = False

        # Send to ntfy if configured
        if self.ntfy_topic:
            try:
                url = f"{self.ntfy_url}/{self.ntfy_topic}"
                headers = {"Title": title}
                requests.post(url, data=message.encode('utf-8'), headers=headers, timeout=10)
            except Exception as e:
                logger.error(f"ntfy notification failed: {e}")
                success = False

        return success
