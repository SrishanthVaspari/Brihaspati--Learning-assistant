"""Push notifications via ntfy.sh."""

import logging
import os

import requests

logger = logging.getLogger(__name__)


def send_ntfy(
    title: str,
    message: str,
    priority: str = "default",
    tags: list[str] | None = None,
) -> bool:
    """Send a push notification via ntfy.sh.

    Reads NTFY_TOPIC and NTFY_SERVER from the environment.
    Returns True on success, False on failure.  Never sends if the topic
    is not configured.
    """
    topic = os.getenv("NTFY_TOPIC", "")
    server = os.getenv("NTFY_SERVER", "https://ntfy.sh")

    if not topic:
        logger.debug("ntfy topic not configured — skipping notification")
        return False

    # Truncate to avoid leaking excessive detail
    title = title[:100]
    message = message[:500]

    headers = {
        "Title": title,
        "Priority": priority,
    }
    if tags:
        headers["Tags"] = ",".join(tags[:5])

    try:
        resp = requests.post(
            f"{server.rstrip('/')}/{topic}",
            data=message.encode("utf-8"),
            headers=headers,
            timeout=10,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        logger.error("ntfy notification failed: %s", e)
        return False


def send_notification(
    title: str,
    message: str,
    priority: str = "default",
    channel: str = "ntfy",
) -> bool:
    """Unified notification dispatcher.

    Currently supports 'ntfy'.  Other channels (e.g. telegram) can be
    added here later.
    """
    if channel == "ntfy":
        return send_ntfy(title, message, priority=priority)

    logger.warning("Unknown notification channel: %s", channel)
    return False
