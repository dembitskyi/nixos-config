{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.steam.enable = lib.mkEnableOption "enable steam";
  };

  config = lib.mkIf config.mine.steam.enable {
    programs.steam = {
      enable = true;
      extraCompatPackages = with pkgs; [ proton-ge-bin ];
      gamescopeSession.enable = true;
    };
  };
}
