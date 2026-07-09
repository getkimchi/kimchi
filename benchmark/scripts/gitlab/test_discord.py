#!/usr/bin/env python3
"""Test Discord bot integration: send message, create thread, reply in thread.

Usage:
    DISCORD_BOT_TOKEN=xxx DISCORD_CHANNEL_ID=123 python3 test_discord.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

API_BASE = "https://discord.com/api/v10"
MAX_CHARS = 2000


def api_request(method: str, url: str, token: str, payload: dict | None = None) -> dict:
    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json",
        "User-Agent": "curl/8.7.1",
    }
    data = json.dumps(payload).encode() if payload else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"HTTP {e.code}: {body}", file=sys.stderr)
        # Parse Discord error code
        try:
            err = json.loads(body)
            code = err.get("code")
            message = err.get("message")
            print(f"Discord error code: {code}, message: {message}", file=sys.stderr)
        except json.JSONDecodeError:
            pass
        raise


def check_permissions(token: str, channel_id: str):
    """Check bot's permissions on the channel."""
    # Get bot user ID
    user = api_request("GET", f"{API_BASE}/users/@me", token)
    bot_id = user["id"]
    print(f"Bot user ID: {bot_id}")

    # Get channel info
    channel = api_request("GET", f"{API_BASE}/channels/{channel_id}", token)
    print(f"Channel: {channel.get('name', '?')} (type={channel.get('type')})")
    print(f"Guild ID: {channel.get('guild_id', 'N/A')}")

    # Compute permissions from guild + channel overrides
    guild_id = channel.get("guild_id")
    if not guild_id:
        print("No guild_id — this might be a DM channel (no threads)", file=sys.stderr)
        return

    # Get bot's member object in the guild (includes roles)
    member = api_request("GET", f"{API_BASE}/guilds/{guild_id}/members/{bot_id}", token)
    roles = member.get("roles", [])
    print(f"Bot roles: {roles}")

    # Get guild roles to compute base permissions
    guild_roles = api_request("GET", f"{API_BASE}/guilds/{guild_id}/roles", token)
    everyone_role = next((r for r in guild_roles if r["id"] == guild_id), None)
    bot_roles = [r for r in guild_roles if r["id"] in roles]

    # Compute permission bits
    perms = 0
    if everyone_role:
        perms |= int(everyone_role.get("permissions", 0))
    for r in bot_roles:
        perms |= int(r.get("permissions", 0))

    # Admin override
    if perms & (1 << 3):  # ADMINISTRATOR
        print("Bot has ADMINISTRATOR — all permissions granted")
        return

    # Apply channel overrides
    overrides = channel.get("permission_overwrites", [])
    # @everyone role overrides
    for o in overrides:
        if o["id"] == guild_id and o["type"] == 0:  # role
            perms &= ~int(o.get("deny", 0))
            perms |= int(o.get("allow", 0))

    # Bot-specific overrides (type 1 = member)
    for o in overrides:
        if o["id"] == bot_id and o["type"] == 1:  # member
            perms &= ~int(o.get("deny", 0))
            perms |= int(o.get("allow", 0))

    # Bot role overrides on this channel
    for o in overrides:
        if o["type"] == 0 and o["id"] in roles:
            perms &= ~int(o.get("deny", 0))
            perms |= int(o.get("allow", 0))

    # Check key permissions
    perm_names = {
        1 << 10: "VIEW_CHANNEL",
        1 << 11: "SEND_MESSAGES",
        1 << 16: "READ_MESSAGE_HISTORY",
        1 << 35: "CREATE_PUBLIC_THREADS",
        1 << 38: "SEND_MESSAGES_IN_THREADS",
    }
    print(f"\nComputed permissions (raw: {perms}):")
    for bit, name in perm_names.items():
        status = "✓" if perms & bit else "✗"
        print(f"  {status} {name}")


def main():
    token = os.environ.get("DISCORD_BOT_TOKEN")
    channel_id = os.environ.get("DISCORD_CHANNEL_ID")
    if not token or not channel_id:
        print("Set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID env vars", file=sys.stderr)
        sys.exit(1)

    # Step 0: Check permissions
    print("0. Checking bot permissions on channel...")
    try:
        check_permissions(token, channel_id)
    except Exception as e:
        print(f"   Permission check failed: {e}", file=sys.stderr)

    # Step 1: Create a thread (no message reference needed)
    print("\n1. Creating thread...")
    thread_url = f"{API_BASE}/channels/{channel_id}/threads"
    resp = api_request("POST", thread_url, token, {"name": "Test Thread", "type": 11})
    thread_id = resp["id"]
    print(f"   ✓ Thread created (id={thread_id})")

    # Step 2: Post message in the thread
    print("2. Posting message in thread...")
    thread_messages_url = f"{API_BASE}/channels/{thread_id}/messages"
    api_request("POST", thread_messages_url, token, {"content": "Message inside the thread ✅"})
    print("   ✓ Message posted in thread")

    print("\nAll tests passed!")


if __name__ == "__main__":
    main()
