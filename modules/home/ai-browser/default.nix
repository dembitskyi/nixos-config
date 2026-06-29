{
  lib,
  config,
  pkgs,
  variables,
  ...
}:
let
  cfg = config.mine.home.ai-browser;
  userHome = "/${variables.homePrefix}/${variables.username}";
  aiDataDir = "${userHome}/.cache/ai-browser";
  chromiumBin = lib.getExe config.programs.chromium.package;

  # Shared CDP flags for both launch paths (desktop entry and systemd service).
  # --remote-allow-origins is only needed when exposing CDP remotely (Chrome
  # >=111 returns 403 on the WebSocket upgrade otherwise) and it loosens
  # DNS-rebinding protection, so gate it on remote.enable.
  cdpFlags =
    "--remote-debugging-port=9222" + lib.optionalString cfg.remote.enable " --remote-allow-origins=*";
in
{

  options = {
    mine.home.ai-browser.enable = lib.mkEnableOption "enable persistent AI browser with CDP";

    mine.home.ai-browser.remote = {
      enable = lib.mkEnableOption "expose the CDP port to the network via a socat proxy (security-sensitive: grants full remote control of the logged-in browser)";

      listenAddress = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        example = "100.64.0.2";
        description = ''
          Interface address the socat CDP proxy binds to. Prefer a trusted
          (Tailscale/WireGuard/LAN) IP over 0.0.0.0. Remote clients must connect
          using this IP literal, not a DNS hostname, or Chrome's DNS-rebinding
          Host-header check rejects them.
        '';
      };

      listenPort = lib.mkOption {
        type = lib.types.port;
        default = 9223;
        description = "Port the socat CDP proxy listens on; forwards to the local CDP port 9222.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.file.".local/share/applications/AIBrowser.desktop".text = ''
      [Desktop Entry]
      Version=1.0
      Name=AIBrowser
      Comment=Chromium with --remote-debugging-port=9222 for Playwright CDP
      Exec=env PULSE_SINK=ai-chromium-sink chromium --class=ai-browser ${cdpFlags} --user-data-dir=${aiDataDir} %U
      Terminal=false
      Type=Application
      Icon=chromium
      Categories=Network;WebBrowser;
      MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/ftp;x-scheme-handler/chrome;video/webm;application/x-xpinstall;
      StartupNotify=true
    '';

    systemd.user.services.ai-browser = {
      Unit = {
        Description = "Persistent AI browser (Chromium with CDP on port 9222)";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };

      Service = {
        Environment = [ "PULSE_SINK=ai-chromium-sink" ];
        ExecStart = "${chromiumBin} --class=ai-browser ${cdpFlags} --user-data-dir=${aiDataDir}";
        Restart = "on-failure";
        RestartSec = 3;
      };
    };

    # Optional socat proxy exposing the localhost-only CDP port to the network.
    # Chromium always binds 9222 to 127.0.0.1; this forwards a chosen interface
    # to it. Standalone (not bound to a single Chromium instance) so it serves
    # both launch paths and is independently supervised. Remote clients connect
    # to http://<listenAddress>:<listenPort> using the IP literal.
    systemd.user.services.ai-browser-cdp-proxy = lib.mkIf cfg.remote.enable {
      Unit = {
        Description = "Expose ai-browser CDP (127.0.0.1:9222) on ${cfg.remote.listenAddress}:${toString cfg.remote.listenPort} via socat";
        After = [
          "ai-browser.service"
          "graphical-session.target"
        ];
        Wants = [ "ai-browser.service" ];
        PartOf = [ "graphical-session.target" ];
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };

      Service = {
        ExecStart = "${lib.getExe pkgs.socat} TCP-LISTEN:${toString cfg.remote.listenPort},fork,reuseaddr,bind=${cfg.remote.listenAddress} TCP:127.0.0.1:9222";
        Restart = "on-failure";
        RestartSec = 3;
      };
    };
  };
}
