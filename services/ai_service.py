import os
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic

def call_ai(prompt: str, context: str = None, structure: str = None) -> str:
    """
    Calls the AI provider (OpenAI or Anthropic) for a response.

    Args:
        prompt: The main user prompt.
        context: Optional context to prepend to the prompt.
        structure: Optional structure hint (not currently implemented for simplicity).

    Returns:
        String AI response or error message.
    """
    provider = os.getenv("AI_PROVIDER", "").lower()
    api_key = os.getenv("API_KEY", "")

    if not api_key:
        return "AI service not configured"

    try:
        if provider == "openai":
            llm = ChatOpenAI(openai_api_key=api_key)
        elif provider == "anthropic":
            llm = ChatAnthropic(anthropic_api_key=api_key)
        else:
            return f"AI provider {provider} not supported"

        full_prompt = f"Context: {context}\n\nPrompt: {prompt}" if context else prompt

        # Simple invocation
        response = llm.invoke(full_prompt)
        return str(response.content)
    except Exception as e:
        return f"AI service error: {str(e)}"
