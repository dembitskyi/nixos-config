{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.fastmcp.proxy;
  userHome = "/${config.variables.homePrefix}/${config.variables.username}";
  proxyPort = toString cfg.port;
  proxyWebPort = toString cfg.webPort;
  proxyLogFile = "${userHome}/.local/state/fastmcp/proxy.log";
  mitmweb = lib.getExe' pkgs.mitmproxy "mitmweb";
  proxyAddon = ./pretty-log-addon.py;
  confDir = "%t/fastmcp-proxy/confdir";

  # Script that sets up the mitmproxy confdir and builds the CA bundle.
  # Both the CA key and cert must be present so mitmproxy reuses them
  # instead of generating a new cert on every restart.
  # Also builds the combined cert bundle (system CAs + mitmproxy CA) that
  # the fastmcp service bind-mounts over /etc/ssl/certs/. Running this in
  # the proxy service (which is ordered Before=fastmcp) guarantees the
  # bundle file exists before fastmcp's namespace is set up.
  # NOTE: uses $XDG_RUNTIME_DIR instead of %t because systemd only expands
  # specifiers in unit file directives, not inside script contents.
  setupProxy = pkgs.writeShellScript "fastmcp-proxy-setup" ''
    set -euo pipefail

    confdir="$XDG_RUNTIME_DIR/fastmcp-proxy/confdir"
    mkdir -p "$confdir"
    cp "$CREDENTIALS_DIRECTORY/mitmproxy_ca" "$confdir/mitmproxy-ca.pem"
    chmod 600 "$confdir/mitmproxy-ca.pem"
    cp "$CREDENTIALS_DIRECTORY/mitmproxy_ca_cert" "$confdir/mitmproxy-ca-cert.pem"
    chmod 644 "$confdir/mitmproxy-ca-cert.pem"

    bundle_dir="${userHome}/.local/state/fastmcp"
    mkdir -p "$bundle_dir"
    cat "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
        "$CREDENTIALS_DIRECTORY/mitmproxy_ca_cert" \
        > "$bundle_dir/ca-bundle.crt"
  '';
in
{
  options.mine.fastmcp.proxy = {
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
      systemd.user.services.fastmcp-proxy = {
        Unit = {
          Description = "FastMCP LLM traffic proxy (mitmweb)";
          Before = [ "fastmcp.service" ];
          PartOf = [ "graphical-session.target" ];
        };

        Install = {
          WantedBy = [ "graphical-session.target" ];
        };

        Service = {
          Environment = [
            "HOME=${userHome}"
            "PROXY_LOG_FILE=${proxyLogFile}"
          ];
          RuntimeDirectory = "fastmcp-proxy";
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
            "--set stream_large_bodies=1m"
            "--set web_password=root"
            "--no-web-open-browser"
            "-s ${proxyAddon}"
            "--quiet"
          ];
          Restart = "on-failure";
          RestartSec = 3;
        };
      };

      # Inject cert bundle bind-mounts into the fastmcp service so that
      # Bun's BoringSSL (which reads /etc/ssl/certs/) trusts the proxy CA.
      systemd.user.services.fastmcp = {
        Unit = {
          After = [ "fastmcp-proxy.service" ];
          Wants = [ "fastmcp-proxy.service" ];
        };
        Service = {
          BindReadOnlyPaths = [
            "%S/fastmcp/ca-bundle.crt:/etc/ssl/certs/ca-bundle.crt"
            "%S/fastmcp/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt"
          ];
        };
      };
    };
  };
}
