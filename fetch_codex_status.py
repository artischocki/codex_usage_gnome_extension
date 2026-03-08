#!/usr/bin/env python3

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_AUTH_PATH = Path.home() / ".codex" / "auth.json"
DEFAULT_URL = "https://chatgpt.com/backend-api/wham/usage"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch Codex usage status from the same backend endpoint used by Codex."
    )
    parser.add_argument(
        "--auth-file",
        default=str(DEFAULT_AUTH_PATH),
        help=f"Path to Codex auth.json (default: {DEFAULT_AUTH_PATH})",
    )
    parser.add_argument(
        "--url",
        default=DEFAULT_URL,
        help=f"Usage endpoint to query (default: {DEFAULT_URL})",
    )
    parser.add_argument(
        "--raw",
        action="store_true",
        help="Print the raw JSON response instead of a summary.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=15.0,
        help="HTTP timeout in seconds (default: 15)",
    )
    return parser.parse_args()


def load_auth(auth_path: Path) -> tuple[str, str]:
    try:
        payload = json.loads(auth_path.read_text())
    except FileNotFoundError:
        raise SystemExit(f"auth file not found: {auth_path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"failed to parse auth file {auth_path}: {exc}")

    tokens = payload.get("tokens") or {}
    access_token = tokens.get("access_token")
    account_id = tokens.get("account_id")

    if not access_token:
        raise SystemExit(f"missing tokens.access_token in {auth_path}")

    if not account_id:
        raise SystemExit(f"missing tokens.account_id in {auth_path}")

    return access_token, account_id


def fetch_usage(url: str, access_token: str, account_id: str, timeout: float) -> dict:
    request = Request(
        url,
        headers={
            "Authorization": f"Bearer {access_token}",
            "ChatGPT-Account-Id": account_id,
            "User-Agent": "codex-status-test-script/1.0",
            "Accept": "application/json",
        },
        method="GET",
    )

    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code}: {body}")
    except URLError as exc:
        raise SystemExit(f"request failed: {exc}")

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"failed to parse response JSON: {exc}")


def format_reset_timestamp(raw_value: object) -> str:
    if not isinstance(raw_value, (int, float)):
        return "unknown"

    dt = datetime.fromtimestamp(raw_value, tz=timezone.utc).astimezone()
    return dt.strftime("%Y-%m-%d %H:%M:%S %Z")


def format_duration(seconds: object) -> str:
    if not isinstance(seconds, (int, float)):
        return "unknown"

    total_seconds = int(seconds)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)

    parts = []
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    if secs or not parts:
        parts.append(f"{secs}s")
    return " ".join(parts)


def print_window(label: str, window: dict | None) -> None:
    if not isinstance(window, dict):
        print(f"{label}: unavailable")
        return

    used_percent = window.get("used_percent")
    window_minutes = window.get("window_minutes")
    limit_window_seconds = window.get("limit_window_seconds")
    reset_after_seconds = window.get("reset_after_seconds")
    resets_at = format_reset_timestamp(window.get("reset_at"))

    if isinstance(window_minutes, int):
        duration = f"{window_minutes} min"
    else:
        duration = format_duration(limit_window_seconds)
    percent = f"{used_percent}%" if isinstance(used_percent, (int, float)) else "unknown"
    reset_after = format_duration(reset_after_seconds)
    print(
        f"{label}: {percent} used, resets in {reset_after} at {resets_at}, window {duration}"
    )


def print_summary(payload: dict) -> None:
    plan_type = payload.get("plan_type", "unknown")
    rate_limit = payload.get("rate_limit") or {}
    credits = payload.get("credits")
    additional = payload.get("additional_rate_limits") or []

    print(f"plan: {plan_type}")
    print_window("primary", rate_limit.get("primary_window"))
    print_window("secondary", rate_limit.get("secondary_window"))

    if isinstance(credits, dict):
        balance = credits.get("balance")
        has_credits = credits.get("has_credits")
        unlimited = credits.get("unlimited")
        print(
            "credits: "
            f"has_credits={has_credits}, unlimited={unlimited}, balance={balance}"
        )

    if additional:
        print("additional_rate_limits:")
        for item in additional:
            if not isinstance(item, dict):
                continue
            limit_name = item.get("limit_name") or item.get("metered_feature") or "unknown"
            print(f"  {limit_name}:")
            nested = item.get("rate_limit") or {}
            print_window("    primary", nested.get("primary_window"))
            print_window("    secondary", nested.get("secondary_window"))


def main() -> None:
    args = parse_args()
    auth_path = Path(args.auth_file).expanduser()
    access_token, account_id = load_auth(auth_path)
    payload = fetch_usage(args.url, access_token, account_id, args.timeout)

    if args.raw:
        json.dump(payload, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return

    print_summary(payload)


if __name__ == "__main__":
    main()
