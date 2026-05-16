{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.home.spotify.enable = lib.mkEnableOption "enable spotify app";
  };

  config = lib.mkIf config.mine.home.spotify.enable {
    home.packages = with pkgs; [ spotify ];
  };
}
