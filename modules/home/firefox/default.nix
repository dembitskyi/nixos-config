{
  lib,
  config,
  pkgs,
  ...
}:
let
  keepassxc = config.mine.home.keepassxc.enable;
in
{

  options = {
    mine.home.firefox.enable = lib.mkEnableOption "enable firefox browser";
  };

  config = lib.mkIf config.mine.home.firefox.enable {
    programs.firefox = {
      enable = true;
      configPath = ".mozilla/firefox";
      nativeMessagingHosts = lib.optional keepassxc pkgs.keepassxc;
      policies.ExtensionSettings = lib.mkIf keepassxc {
        "keepassxc-browser@keepassxc.org" = {
          installation_mode = "force_installed";
          install_url = "https://addons.mozilla.org/firefox/downloads/latest/keepassxc-browser/latest.xpi";
        };
      };
    };
  };
}
