"""mitmproxy addon: no upstreams on this machine."""

import ipaddress
import socket

from mitmproxy import ctx
from mitmproxy.proxy import server_hooks


def _local(ip: str) -> bool:
    family = (
        socket.AF_INET6 if ipaddress.ip_address(ip).version == 6 else socket.AF_INET
    )
    with socket.socket(family, socket.SOCK_DGRAM) as probe:
        try:
            probe.bind((ip, 0))
        except OSError:
            return False
    return True


class LocalGuard:
    def server_connect(self, data: server_hooks.ServerConnectionHookData) -> None:
        if data.server.address is None:
            return
        host, port = data.server.address
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as e:
            data.server.error = f"cannot resolve {host}: {e}"
            return
        ips = [info[4][0] for info in infos]
        local = [ip for ip in ips if _local(ip)]
        if local:
            ctx.log.warn(f"refused {host}:{port} ({local[0]} is this machine)")
            data.server.error = (
                "the AI sandbox's proxy does not connect to this machine"
            )
            return
        data.server.address = (ips[0], port)


addons = [LocalGuard()]
