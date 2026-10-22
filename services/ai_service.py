
import os
import json
import logging
import re

from langchain_ollama import ChatOllama
from langchain_openai import AzureChatOpenAI

logger = logging.getLogger(__name__)


def call_ai(prompt: str, context: str = None, structure: str = None) -> str:
    """Call the configured AI provider."""
    service = AIService()
    return service.call_ai(
        prompt,
        context=context,
        structure=structure,
    )


class AIService:
    """Generate text and structured JSON using Ollama or Azure OpenAI."""

    def __init__(self):
        self.provider = os.getenv("AI_PROVIDER", "ollama").lower().strip()
        self.model = os.getenv("AI_MODEL", "qwen3:4b")

    def _get_llm(self):
        """Create the configured language model."""
        if self.provider == "ollama":
            return ChatOllama(
                base_url=os.getenv(
                    "OLLAMA_BASE_URL",
                    "http://localhost:11434",
                ),
                model=self.model,
                temperature=0,
            )

        if self.provider == "azure":
            return AzureChatOpenAI(
                azure_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT"),
                api_key=os.getenv("AZURE_OPENAI_KEY"),
                api_version=os.getenv("AZURE_OPENAI_API_VERSION"),
                azure_deployment=os.getenv(
                    "AZURE_OPENAI_DEPLOYMENT_NAME"
                ),
                temperature=0,
            )

        raise ValueError(
            f"Unsupported AI provider: {self.provider}"
        )

    def call_ai(
        self,
        prompt: str,
        context: str = None,
        structure: str = None,
    ) -> str:
        """Generate a regular text response."""
        full_prompt = (
            f"Context:\n{context}\n\nPrompt:\n{prompt}"
            if context
            else prompt
        )

        if structure:
            full_prompt += (
                f"\n\nRequired response structure:\n{structure}"
            )

        try:
            response = self._get_llm().invoke(full_prompt)
            return str(response.content)
        except Exception:
            logger.exception("AI text generation failed")
            raise

    def generate_json(
        self,
        prompt: str,
        system: str = None,
    ) -> list | dict:
        """Generate and parse a JSON array or object."""
        full_prompt = (
            f"{system or 'You are a helpful assistant.'}\n\n"
            f"{prompt}\n\n"
            "Return only valid JSON. Do not include Markdown fences "
            "or explanatory text outside the JSON."
        )

        try:
            response = self._get_llm().invoke(full_prompt)
            content = str(response.content).strip()

            # Remove Qwen's optional reasoning block.
            content = re.sub(
                r"<think>.*?</think>",
                "",
                content,
                flags=re.DOTALL,
            ).strip()

            # Remove Markdown code fences.
            content = re.sub(
                r"^\s*```(?:json)?\s*",
                "",
                content,
                flags=re.IGNORECASE,
            )
            content = re.sub(
                r"\s*```\s*$",
                "",
                content,
            ).strip()

            # First, try parsing the complete response.
            try:
                data = json.loads(content)
            except json.JSONDecodeError:
                # Find a valid JSON array or object inside extra text.
                decoder = json.JSONDecoder()
                data = None

                for index, char in enumerate(content):
                    if char not in "[{":
                        continue

                    try:
                        candidate, _ = decoder.raw_decode(
                            content[index:]
                        )
                    except json.JSONDecodeError:
                        continue

                    if isinstance(candidate, (list, dict)):
                        data = candidate
                        break

                if data is None:
                    logger.error(
                        "No valid JSON found in AI response. "
                        "Response preview: %r",
                        content[:1000],
                    )
                    raise ValueError(
                        "AI returned no valid JSON. "
                        "See the application terminal for details."
                    )

            # Support either a direct array or {"questions": [...]}.
            if (
                isinstance(data, dict)
                and isinstance(data.get("questions"), list)
            ):
                data = data["questions"]

            if not isinstance(data, (list, dict)):
                raise ValueError(
                    "AI response must be a JSON array or object."
                )

            logger.info(
                "AI JSON parsed successfully; type=%s, items=%s",
                type(data).__name__,
                len(data),
            )
            return data

        except Exception:
            logger.exception("AI JSON generation failed")
            raise
