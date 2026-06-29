{
  lib,
  config,
  pkgs,
  ...
}:
{
  options = {
    mine.home.sioyek.enable = lib.mkEnableOption "enable sioyek pdf viewer";
  };

  config = lib.mkIf config.mine.home.sioyek.enable {
    home.packages = [
      pkgs.sioyek
    ];
  };
}
