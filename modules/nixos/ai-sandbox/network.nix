# The sandbox's network.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.ai-sandbox;
  net = cfg.network;
  units = import ./units.nix { inherit lib pkgs config; };
  link = "ai-sandbox";
  ip = lib.getExe' pkgs.iproute2 "ip";
  sysctl = lib.getExe' pkgs.procps "sysctl";

  up = pkgs.writeShellScript "ai-sandbox-network-up" ''
    set -eu
    ${ip} netns del ai-sandbox 2>/dev/null || true
    ${ip} link del ${link} 2>/dev/null || true
    ${ip} netns add ai-sandbox
    ${ip} link add ${link} type veth peer name eth0 netns ai-sandbox
    ${ip} addr add ${net.hostAddress}/30 dev ${link}
    ${ip} -n ai-sandbox addr add ${net.address}/30 dev eth0
    ${ip} -n ai-sandbox link set lo up
    ${sysctl} -q -w net.ipv6.conf.${link}.disable_ipv6=1
    ${ip} netns exec ai-sandbox ${sysctl} -q -w net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1
    ${ip} link set ${link} up
    ${ip} -n ai-sandbox link set eth0 up
    ${ip} -n ai-sandbox route add default via ${net.hostAddress}
  '';
  down = pkgs.writeShellScript "ai-sandbox-network-down" ''
    ${ip} netns del ai-sandbox 2>/dev/null || true
    ${ip} link del ${link} 2>/dev/null || true
  '';

  hostPort = port: {
    socket = {
      description = "Host port ${port} in the AI sandbox";
      after = [ units.network ];
      bindsTo = [ units.network ];
      socketConfig = {
        ListenStream = "127.0.0.1:${port}";
        NetworkNamespacePath = units.netns;
      };
    };
    service = {
      description = "Host port ${port} in the AI sandbox (proxy)";
      serviceConfig = {
        ExecStart = "${config.systemd.package}/lib/systemd/systemd-socket-proxyd 127.0.0.1:${port}";
        DynamicUser = true;
      };
    };
  };

  portCommand = pkgs.writeShellApplication {
    name = "ai-sandbox-port";
    runtimeInputs = [ pkgs.systemd ];
    text = ''
      usage() {
        echo "usage: ai-sandbox-port open|close PORT... | list" >&2
        exit 2
      }
      verb="''${1:-}"
      shift || true
      case "$verb" in
        list)
          systemctl list-units --plain --no-legend 'ai-sandbox-port@*.socket' | cut -d' ' -f1
          exit 0
          ;;
        open) action=start ;;
        close) action=stop ;;
        *) usage ;;
      esac
      [ "$#" -gt 0 ] || usage
      for port in "$@"; do
        if ! [[ $port =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
          echo "ai-sandbox-port: not a port: $port" >&2
          exit 2
        fi
        systemctl "$action" "ai-sandbox-port@$port.socket"
      done
    '';
  };

  private = [
    "10.0.0.0/8"
    "172.16.0.0/12"
    "192.168.0.0/16"
    "100.64.0.0/10"
    "169.254.0.0/16"
  ];
in
{
  options.mine.ai-sandbox.network = {
    hostPorts = lib.mkOption {
      type = lib.types.listOf lib.types.port;
      default = [ ];
      description = "Services on the host's loopback the sandbox may use, at the same 127.0.0.1:<port> inside.";
    };

    allowedPrivateAddresses = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "192.168.1.50" ];
      description = "LAN or VPN addresses (or prefixes) the sandbox may reach; other private addresses are refused.";
    };

    nameservers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "1.1.1.1"
        "9.9.9.9"
      ];
      description = "DNS servers of the sandbox (the host's resolver is not on its network).";
    };

    address = lib.mkOption {
      type = lib.types.str;
      default = "10.233.0.2";
      description = "The sandbox's address; the host knows it as ai-sandbox.";
    };

    hostAddress = lib.mkOption {
      type = lib.types.str;
      default = "10.233.0.1";
      description = "The host's end of the cable (a /30 with the sandbox's address).";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.hosts.${net.address} = [ "ai-sandbox" ];

    networking.firewall.extraCommands = ''
      iptables -N ai-sandbox-in 2>/dev/null || iptables -F ai-sandbox-in
      iptables -D INPUT -i ${link} -j ai-sandbox-in 2>/dev/null || true
      iptables -I INPUT -i ${link} -j ai-sandbox-in
      iptables -A ai-sandbox-in -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
      iptables -A ai-sandbox-in -p tcp -j REJECT --reject-with tcp-reset
      iptables -A ai-sandbox-in -j REJECT --reject-with icmp-port-unreachable

      iptables -N ai-sandbox-fwd 2>/dev/null || iptables -F ai-sandbox-fwd
      iptables -D FORWARD -j ai-sandbox-fwd 2>/dev/null || true
      iptables -I FORWARD -j ai-sandbox-fwd
      iptables -P FORWARD DROP
      iptables -A ai-sandbox-fwd -o ${link} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
      iptables -A ai-sandbox-fwd -o ${link} -j REJECT --reject-with icmp-port-unreachable
      ${lib.concatMapStringsSep "\n" (
        address: "iptables -A ai-sandbox-fwd -i ${link} -d ${address} -j ACCEPT"
      ) net.allowedPrivateAddresses}
      ${lib.concatMapStringsSep "\n" (
        range:
        "iptables -A ai-sandbox-fwd -i ${link} -d ${range} -j REJECT --reject-with icmp-net-prohibited"
      ) private}
      iptables -A ai-sandbox-fwd -i ${link} -j ACCEPT

      iptables -t nat -N ai-sandbox-nat 2>/dev/null || iptables -t nat -F ai-sandbox-nat
      iptables -t nat -D POSTROUTING -j ai-sandbox-nat 2>/dev/null || true
      iptables -t nat -I POSTROUTING -j ai-sandbox-nat
      iptables -t nat -A ai-sandbox-nat -s ${net.address} ! -o ${link} -j MASQUERADE

      ip6tables -D INPUT -i ${link} -j DROP 2>/dev/null || true
      ip6tables -I INPUT -i ${link} -j DROP
    '';
    networking.firewall.extraStopCommands = ''
      iptables -D INPUT -i ${link} -j ai-sandbox-in 2>/dev/null || true
      iptables -D FORWARD -j ai-sandbox-fwd 2>/dev/null || true
      iptables -t nat -D POSTROUTING -j ai-sandbox-nat 2>/dev/null || true
      iptables -F ai-sandbox-in 2>/dev/null || true
      iptables -X ai-sandbox-in 2>/dev/null || true
      iptables -F ai-sandbox-fwd 2>/dev/null || true
      iptables -X ai-sandbox-fwd 2>/dev/null || true
      iptables -t nat -F ai-sandbox-nat 2>/dev/null || true
      iptables -t nat -X ai-sandbox-nat 2>/dev/null || true
      ip6tables -D INPUT -i ${link} -j DROP 2>/dev/null || true
    '';
    boot.kernel.sysctl."net.ipv4.ip_forward" = 1;

    systemd.sockets = {
      "ai-sandbox-port@" = (hostPort "%i").socket;
    }
    // lib.listToAttrs (
      map (
        port:
        lib.nameValuePair "ai-sandbox-host-${toString port}" (
          (hostPort (toString port)).socket // { wantedBy = [ "sockets.target" ]; }
        )
      ) net.hostPorts
    );
    systemd.services = {
      ai-sandbox-network = {
        description = "AI sandbox network (namespace and cable to the host)";
        unitConfig.DefaultDependencies = false;
        wantedBy = [ "sockets.target" ];
        before = [
          "sockets.target"
          "shutdown.target"
        ];
        conflicts = [ "shutdown.target" ];
        restartIfChanged = false;
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = up;
          ExecStop = down;
        };
      };
      "ai-sandbox-port@" = (hostPort "%i").service;
    }
    // lib.listToAttrs (
      map (
        port: lib.nameValuePair "ai-sandbox-host-${toString port}" (hostPort (toString port)).service
      ) net.hostPorts
    );

    environment.systemPackages = [ portCommand ];
    security.polkit.extraConfig = ''
      polkit.addRule(function (action, subject) {
        if (action.id == "org.freedesktop.systemd1.manage-units" && subject.user == "${config.variables.username}" &&
            subject.local && subject.active &&
            /^ai-sandbox-port@[0-9]+\.socket$/.test(action.lookup("unit")) &&
            ["start", "stop"].indexOf(action.lookup("verb")) >= 0) {
          return polkit.Result.YES;
        }
      });
    '';
  };
}
