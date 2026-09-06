"""Optional compatibility smoke test with the Python MCP SDK used by Hermes.
Run with Hermes's Python environment; no model or personal config is loaded.
"""
import asyncio
import json
from pathlib import Path
import shutil

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    node = shutil.which("node")
    assert node, "Node.js 22+ is required"
    entry = Path(__file__).resolve().parent.parent / "mcp" / "server.mjs"
    params = StdioServerParameters(command=node, args=[str(entry)])
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            initialized = (await session.initialize()).model_dump(by_alias=True)
            assert initialized["serverInfo"]["name"] == "tabagent"
            listing = await session.list_tools()
            assert len(listing.tools) == 14
            result = (await session.call_tool("tabagent_tabs", {})).model_dump(by_alias=True)
            assert not result.get("isError")
            assert json.loads(result["content"][0]["text"]) == {"tabs": []}
            print("PASS: Python MCP SDK initializes the real companion, discovers 14 tools and lists shared tabs")


asyncio.run(main())
