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
  confDir = "/run/ai-sandbox-proxy/confdir";

  setupProxy = pkgs.writeShellScript "ai-sandbox-proxy-setup" ''
    set -euo pipefail

    confdir="${confDir}"
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
    mine.ai-sandbox.network.hostPorts = [ cfg.port ];

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

    systemd.services.ai-sandbox-proxy = {
      description = "AI Sandbox LLM traffic proxy (mitmweb)";
      serviceConfig = {
        User = config.variables.username;
        Group = config.users.users.${config.variables.username}.group;
        Environment = [
          "HOME=${userHome}"
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
          "--listen-host 127.0.0.1"
          "--listen-port ${proxyPort}"
          "--web-port ${proxyWebPort}"
          "--web-host 127.0.0.1"
          "--set web_password=root"
          "--no-web-open-browser"
          "-s ${./flow-limit.py}"
          "-s ${./local-guard.py}"
          "--quiet"
        ];
        Restart = "on-failure";
        RestartSec = 3;
        MemoryMax = "8G";
        MemorySwapMax = "0";
      };
    };
  };
}
