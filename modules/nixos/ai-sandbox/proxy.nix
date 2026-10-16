{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.ai-sandbox.proxy;
  userHome = "/${config.variables.homePrefix}/${config.variables.username}";
  proxyPort = toString cfg.port;
  proxyWebPort = toString cfg.webPort;
  mitmweb = lib.getExe' pkgs.mitmproxy "mitmweb";
  confDir = "%t/ai-sandbox-proxy/confdir";

  # Sets up the mitmproxy confdir (CA key and cert, so it reuses them) and
  # the CA bundle the sandboxed units bind over /etc/ssl/certs (units.nix).
  # NOTE: uses $XDG_RUNTIME_DIR instead of %t because systemd only expands
  # specifiers in unit file directives, not inside script contents.
  setupProxy = pkgs.writeShellScript "ai-sandbox-proxy-setup" ''
    set -euo pipefail

    confdir="$XDG_RUNTIME_DIR/ai-sandbox-proxy/confdir"
    mkdir -p "$confdir"
    cp "$CREDENTIALS_DIRECTORY/mitmproxy_ca" "$confdir/mitmproxy-ca.pem"
    chmod 600 "$confdir/mitmproxy-ca.pem"
    cp "$CREDENTIALS_DIRECTORY/mitmproxy_ca_cert" "$confdir/mitmproxy-ca-cert.pem"
    chmod 644 "$confdir/mitmproxy-ca-cert.pem"

    bundle_dir="${userHome}/.local/state/ai-sandbox"
    mkdir -p "$bundle_dir"
    cat "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
        "$CREDENTIALS_DIRECTORY/mitmproxy_ca_cert" \
        > "$bundle_dir/ca-bundle.crt"
  '';
in
{
  options.mine.ai-sandbox.proxy = {
    enable = lib.mkEnableOption "mitmproxy for tracing the AI sandbox's traffic (opencode servers and agent sessions)";

    port = lib.mkOption {
      type = lib.types.port;
      default = 8888;
      description = "Port for the mitmweb forward proxy.";
    };

    webPort = lib.mkOption {
      type = lib.types.port;
      default = 5011;
      description = "Port for the mitmweb interactive UI.";
    };
  };

  config = lib.mkIf cfg.enable {
    sops.secrets = {
      "MCP/MITMPROXY_CA" = {
        owner = config.variables.username;
        mode = "0400";
      };
      "MCP/MITMPROXY_CA_CERT" = {
        owner = config.variables.username;
        mode = "0444";
      };
    };

    home-manager.users.${config.variables.username} = {
      # Started by the first unit that wants it; keeps its flows until logout.
      systemd.user.services.ai-sandbox-proxy = {
        Unit = {
          Description = "AI Sandbox LLM traffic proxy (mitmweb)";
          PartOf = [ "graphical-session.target" ];
        };

        Service = {
          Environment = [
            "HOME=${userHome}"
            # glibc keeps freed body buffers in per-thread arenas and grows its
            # mmap threshold up to 32 MiB, so freed memory rarely went back to
            # the system. Buffers of 1 MiB and more now get their own mapping,
            # returned on free, and two arenas bound the fragmentation
            # (flow-limit.py also trims the heap after shedding flows).
            "MALLOC_ARENA_MAX=2"
            "MALLOC_MMAP_THRESHOLD_=1048576"
          ];
          RuntimeDirectory = "ai-sandbox-proxy";
          UMask = "0077";
          LoadCredential = [
            "mitmproxy_ca:${config.sops.secrets."MCP/MITMPROXY_CA".path}"
            "mitmproxy_ca_cert:${config.sops.secrets."MCP/MITMPROXY_CA_CERT".path}"
          ];
          ExecStartPre = "${setupProxy}";
          ExecStart = lib.concatStringsSep " " [
            mitmweb
            "--set confdir=${confDir}"
            "--mode regular"
            "--listen-port ${proxyPort}"
            "--web-port ${proxyWebPort}"
            "--web-host 127.0.0.1"
            "--set web_password=root"
            "--no-web-open-browser"
            "-s ${./flow-limit.py}"
            "--quiet"
          ];
          Restart = "on-failure";
          RestartSec = 3;
          # flow-limit.py sheds flows from 5 GiB resident and stops recording
          # at 6.5 GiB, well before this limit. Without the swap cap, hitting
          # MemoryMax thrashes instead of restarting.
          MemoryMax = "8G";
          MemorySwapMax = "0";
        };
      };
    };
  };
}
