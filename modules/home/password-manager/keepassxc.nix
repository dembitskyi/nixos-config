{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.home.keepassxc.enable = lib.mkEnableOption "enable password manager (keepassxc)";
  };

  config = lib.mkIf config.mine.home.keepassxc.enable {
    home.packages = with pkgs; [ keepassxc ];
  };
}
