#!/usr/bin/env python3
"""
Yassir LMD Ops Copilot — Multi-Provider LLM + MCP Client

Supports (in priority order — first key found wins):
  CEREBRAS_API_KEY  → 1M tokens/day FREE   https://cloud.cerebras.ai
  GEMINI_API_KEY    → 1500 req/day FREE     https://aistudio.google.com/apikey
  SAMBANOVA_API_KEY → 200K tok/day + $5     https://cloud.sambanova.ai
  GROQ_API_KEY      → 100K tok/day FREE     https://console.groq.com/keys
  OPENAI_API_KEY    → paid                  https://platform.openai.com

Usage:
  pip install openai mcp
  CEREBRAS_API_KEY=csk-... python3 openai-client.py

Override model:
  OPENAI_MODEL=gpt-4o OPENAI_API_KEY=sk-... python3 openai-client.py
"""

import asyncio
import json
import os
import sys
from pathlib import Path

try:
    from openai import OpenAI
except ImportError:
    print("Install openai: pip install openai")
    sys.exit(1)

try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
except ImportError:
    print("Install mcp: pip install mcp")
    sys.exit(1)


MCP_SERVER_PATH = str(Path(__file__).parent / "dist" / "index.js")
SYSTEM_PROMPT = (Path(__file__).parent / "system-prompt.txt").read_text(encoding="utf-8")

PROVIDERS = [
    {
        "env_key": "CEREBRAS_API_KEY",
        "name": "Cerebras",
        "base_url": "https://api.cerebras.ai/v1",
        "default_model": "gpt-oss-120b",
        "free_tier": "1M tokens/day",
        "signup": "https://cloud.cerebras.ai",
    },
    {
        "env_key": "GEMINI_API_KEY",
        "name": "Gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "default_model": "gemini-2.0-flash",
        "free_tier": "1500 req/day, 1M TPM",
        "signup": "https://aistudio.google.com/apikey",
    },
    {
        "env_key": "SAMBANOVA_API_KEY",
        "name": "SambaNova",
        "base_url": "https://api.sambanova.ai/v1",
        "default_model": "Meta-Llama-3.1-8B-Instruct",
        "free_tier": "200K tokens/day + $5 credit",
        "signup": "https://cloud.sambanova.ai",
    },
    {
        "env_key": "GROQ_API_KEY",
        "name": "Groq",
        "base_url": "https://api.groq.com/openai/v1",
        "default_model": "llama-3.3-70b-versatile",
        "free_tier": "100K tokens/day",
        "signup": "https://console.groq.com/keys",
    },
    {
        "env_key": "OPENAI_API_KEY",
        "name": "OpenAI",
        "base_url": None,
        "default_model": "gpt-4o-mini",
        "free_tier": "paid only",
        "signup": "https://platform.openai.com",
    },
]

MAX_TOOL_RESULT_CHARS = 4000
MAX_HISTORY_MESSAGES = 40
TRIM_KEEP_RECENT = 20


def create_client():
    """Create OpenAI-compatible client. Checks keys in priority order."""
    for provider in PROVIDERS:
        api_key = os.environ.get(provider["env_key"])
        if api_key:
            model = os.environ.get("OPENAI_MODEL", provider["default_model"])
            kwargs = {"api_key": api_key}
            if provider["base_url"]:
                kwargs["base_url"] = provider["base_url"]
            client = OpenAI(**kwargs)
            return client, model, provider["name"]

    print("\n  No API key found. Set one of these (sorted by free-tier generosity):\n")
    for p in PROVIDERS:
        print(f"    {p['env_key']:24s} {p['free_tier']:30s} {p['signup']}")
    print()
    sys.exit(1)


llm_client, MODEL, PROVIDER = create_client()


def mcp_tool_to_openai(name: str, description: str, input_schema: dict) -> dict:
    """Convert MCP tool definition to OpenAI function calling format."""
    schema = dict(input_schema) if input_schema else {"type": "object", "properties": {}}
    schema.pop("additionalProperties", None)
    schema.pop("$schema", None)
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description or "",
            "parameters": schema,
        },
    }


def trim_history(messages: list) -> list:
    """Keep system prompt + most recent messages to stay under token limits."""
    if len(messages) > MAX_HISTORY_MESSAGES:
        messages = [messages[0]] + messages[-TRIM_KEEP_RECENT:]
    return messages


async def main():
    env = {**os.environ}
    env_file = Path(__file__).parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()

    server_params = StdioServerParameters(
        command="node",
        args=[MCP_SERVER_PATH],
        env=env,
    )

    print(f"Connecting to MCP server: {MCP_SERVER_PATH}")
    print(f"Provider: {PROVIDER} | Model: {MODEL}")
    print("-" * 60)

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools_result = await session.list_tools()
            mcp_tools = {t.name: t for t in tools_result.tools}
            openai_tools = [
                mcp_tool_to_openai(t.name, t.description or "", t.inputSchema)
                for t in tools_result.tools
            ]

            print(f"Connected! {len(mcp_tools)} tools available.")
            for name in sorted(mcp_tools):
                print(f"  - {name}")
            print("-" * 60)
            print("Ask anything about Yassir LMD operations. Type 'quit' to exit.\n")

            messages = [{"role": "system", "content": SYSTEM_PROMPT}]

            while True:
                try:
                    user_input = input("You> ").strip()
                except (EOFError, KeyboardInterrupt):
                    print("\nGoodbye!")
                    break

                if not user_input:
                    continue
                if user_input.lower() in ("quit", "exit", "q"):
                    print("Goodbye!")
                    break

                messages = trim_history(messages)
                messages.append({"role": "user", "content": user_input})

                max_tool_rounds = 8
                for _ in range(max_tool_rounds):
                    try:
                        response = llm_client.chat.completions.create(
                            model=MODEL,
                            messages=messages,
                            tools=openai_tools if openai_tools else None,
                            temperature=0.1,
                        )
                    except Exception as api_err:
                        err_str = str(api_err)
                        print(f"\n  [API Error: {err_str[:300]}]\n")
                        if "rate_limit" in err_str.lower() or "429" in err_str:
                            print("  Tip: Switch provider. Set a different API key env var.\n")
                        messages.pop()
                        break

                    choice = response.choices[0]

                    if choice.finish_reason == "tool_calls" or choice.message.tool_calls:
                        messages.append(choice.message)

                        for tc in choice.message.tool_calls:
                            fn_name = tc.function.name
                            try:
                                fn_args = json.loads(tc.function.arguments) if tc.function.arguments else {}
                            except json.JSONDecodeError:
                                fn_args = {}
                            print(f"  [calling {fn_name}({json.dumps(fn_args, ensure_ascii=False)[:120]})]")

                            try:
                                result = await session.call_tool(fn_name, fn_args)
                                result_text = "\n".join(
                                    c.text for c in result.content if hasattr(c, "text")
                                )
                            except Exception as e:
                                result_text = f"Error: {e}"

                            messages.append({
                                "role": "tool",
                                "tool_call_id": tc.id,
                                "content": result_text[:MAX_TOOL_RESULT_CHARS],
                            })
                    else:
                        if choice.message.content:
                            print(f"\nAssistant> {choice.message.content}\n")
                            messages.append({
                                "role": "assistant",
                                "content": choice.message.content,
                            })
                        break


if __name__ == "__main__":
    asyncio.run(main())
