{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.home.brave.enable = lib.mkEnableOption "enable brave browser";
  };

  config = lib.mkIf config.mine.home.brave.enable {
    home.packages = with pkgs; [ brave ];
  };
}
