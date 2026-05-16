{
  lib,
  config,
  pkgs,
  variables,
  ...
}:
let
  userHome = "/${variables.homePrefix}/${variables.username}";
  aiDataDir = "${userHome}/.cache/ai-browser";
  chromiumBin = lib.getExe config.programs.chromium.package;
in
{

  options = {
    mine.home.ai-browser.enable = lib.mkEnableOption "enable persistent AI browser with CDP";
  };

  config = lib.mkIf config.mine.home.ai-browser.enable {
    home.file.".local/share/applications/AIBrowser.desktop".text = ''
      [Desktop Entry]
      Version=1.0
      Name=AIBrowser
      Comment=Chromium with --remote-debugging-port=9222 for Playwright CDP
      Exec=env PULSE_SINK=ai-chromium-sink chromium --class=ai-browser --remote-debugging-port=9222 --user-data-dir=${aiDataDir} %U
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
        ExecStart = "${chromiumBin} --class=ai-browser --remote-debugging-port=9222 --user-data-dir=${aiDataDir}";
        Restart = "on-failure";
        RestartSec = 3;
      };
    };
  };
}
