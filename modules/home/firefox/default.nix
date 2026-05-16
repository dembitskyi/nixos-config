{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.home.firefox.enable = lib.mkEnableOption "enable firefox browser";
  };

  config = lib.mkIf config.mine.home.firefox.enable {
    programs.firefox = {
      enable = true;
      configPath = ".mozilla/firefox";
    };
  };
}
