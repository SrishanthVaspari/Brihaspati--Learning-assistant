import requests
import logging
import json

logger = logging.getLogger(__name__)

class AnkiService:
    """Service to interact with AnkiConnect API."""

    def __init__(self, api_url: str = "http://localhost:8765"):
        self.api_url = api_url

    def _call_anki(self, action: str, params: dict = None):
        """Call the AnkiConnect API."""
        payload = {
            "action": action,
            "version": 6,
            "params": params or {}
        }
        try:
            response = requests.post(self.api_url, json=payload, timeout=10)
            response.raise_for_status()
            result = response.json()
            if result.get("error"):
                logger.error(f"AnkiConnect error: {result['error']}")
                return None
            return result.get("result")
        except Exception as e:
            logger.error(f"Failed to connect to Anki: {e}")
            return None

    def is_connected(self):
        """Check if AnkiConnect is accessible."""
        return self._call_anki("version") is not None

    def get_decks(self):
        """List all decks."""
        return self._call_anki("deckNames")

    def create_deck(self, deck_name: str):
        """Create a new Anki deck."""
        return self._call_anki("createDeck", {"deck": deck_name})

    def add_note(self, deck_name: str, question: str, answer: str, tags: list[str] = None):
        """Add a note to a deck."""
        note = {
            "deckName": deck_name,
            "modelName": "Basic",
            "fields": {
                "Front": question,
                "Back": answer
            },
            "options": {
                "allowDuplicate": False,
            },
            "tags": tags or []
        }
        return self._call_anki("addNote", {"note": note})
