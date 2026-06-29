"""D-Bus notification monitor.

Intercepts org.freedesktop.Notifications.Notify calls on the session bus
and invokes a hook script with (app_name, summary, body) arguments.
"""

import asyncio
import logging
import subprocess
import sys
from pathlib import Path

from dbus_next import BusType, MessageType
from dbus_next.aio import MessageBus
from dbus_next.message import Message

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)
log = logging.getLogger("notification-monitor")


def parse_body(body: str) -> tuple[str, str]:
    """Extract origin and message content from the body.

    Browser notifications prepend the origin (e.g. 'app.slack.com') followed
    by a double newline before the actual message.
    Returns (origin or empty string, message content).
    """
    parts = body.split("\n\n", 1)
    if len(parts) == 2 and "." in parts[0] and " " not in parts[0]:
        return parts[0], parts[1]
    return "", body


def invoke_hook(
    hook_script: str | None, app_name: str, summary: str, body: str
) -> None:
    """Log the notification and optionally fire the hook script."""
    origin, body = parse_body(body)
    if origin:
        app_name = f"{app_name}({origin})"
    log.info("app=%r summary=%r body=%r", app_name, summary, body)
    if not hook_script:
        return
    try:
        subprocess.Popen(
            [hook_script, app_name, summary, body],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        log.exception("Hook failed")


async def monitor(hook_script: str | None) -> None:
    """Connect to the session bus and monitor Notify method calls."""
    bus = await MessageBus(bus_type=BusType.SESSION).connect()
    log.info("Connected to session bus: %s", bus.unique_name)

    reply = await bus.call(
        Message(
            destination="org.freedesktop.DBus",
            path="/org/freedesktop/DBus",
            interface="org.freedesktop.DBus.Monitoring",
            member="BecomeMonitor",
            signature="asu",
            body=[
                [
                    "type='method_call',"
                    "interface='org.freedesktop.Notifications',"
                    "member='Notify'"
                ],
                0,
            ],
        )
    )
    if reply.message_type == MessageType.ERROR:
        log.error("BecomeMonitor failed: %s", reply.body)
        sys.exit(1)

    # After BecomeMonitor, the connection is purely passive. Prevent dbus-next
    # from sending replies to observed method calls (which would cause the bus
    # daemon to close our connection).
    bus.send = lambda msg: None

    log.info("Monitoring started")

    def on_message(msg):
        try:
            if (
                msg.message_type != MessageType.METHOD_CALL
                or msg.interface != "org.freedesktop.Notifications"
                or msg.member != "Notify"
            ):
                return
            # Notify(s app_name, u replaces_id, s icon, s summary, s body, ...).
            args = msg.body
            if len(args) < 5:
                return
            invoke_hook(hook_script, str(args[0]), str(args[3]), str(args[4]))
        except Exception:
            log.exception("Error handling notification")

    bus.add_message_handler(on_message)
    try:
        await bus.wait_for_disconnect()
    except EOFError:
        log.info("Bus connection closed, exiting")


def main() -> None:
    hook_script = sys.argv[1] if len(sys.argv) > 1 else None
    if hook_script and not Path(hook_script).is_file():
        log.error("Hook script not found: %s", hook_script)
        sys.exit(1)

    log.info("Starting, hook=%s", hook_script or "none (log only)")
    try:
        asyncio.run(monitor(hook_script))
    except KeyboardInterrupt:
        log.info("Shutting down")


if __name__ == "__main__":
    main()
