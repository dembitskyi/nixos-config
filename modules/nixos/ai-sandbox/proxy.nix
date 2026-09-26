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

  # Script that sets up the mitmproxy confdir and builds the CA bundle.
  # Both the CA key and cert must be present so mitmproxy reuses them
  # instead of generating a new cert on every restart.
  # Also builds the combined cert bundle (system CAs + mitmproxy CA) that
  # the AI sandbox service bind-mounts over /etc/ssl/certs/. Running this in
  # the proxy service (which is ordered Before=ai-sandbox) guarantees the
  # bundle file exists before the AI sandbox's namespace is set up.
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
    enable = lib.mkEnableOption "mitmproxy for tracing opencode LLM provider traffic";

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
      systemd.user.services.ai-sandbox-proxy = {
        Unit = {
          Description = "AI Sandbox LLM traffic proxy (mitmweb)";
          Before = [ "ai-sandbox.service" ];
          PartOf = [ "graphical-session.target" ];
        };

        Install = {
          WantedBy = [ "graphical-session.target" ];
        };

        Service = {
          Environment = [ "HOME=${userHome}" ];
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
          # Without the swap cap, hitting MemoryMax thrashes instead of restarting.
          MemoryMax = "8G";
          MemorySwapMax = "0";
        };
      };

      # Inject cert bundle bind-mounts into the AI sandbox service so that
      # Bun's BoringSSL (which reads /etc/ssl/certs/) trusts the proxy CA.
      systemd.user.services.ai-sandbox = {
        Unit = {
          After = [ "ai-sandbox-proxy.service" ];
          Wants = [ "ai-sandbox-proxy.service" ];
        };
        Service = {
          BindReadOnlyPaths = [
            "%S/ai-sandbox/ca-bundle.crt:/etc/ssl/certs/ca-bundle.crt"
            "%S/ai-sandbox/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt"
          ];
        };
      };
    };
  };
}
