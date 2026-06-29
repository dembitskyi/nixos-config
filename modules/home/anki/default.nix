{
  lib,
  config,
  pkgs,
  ...
}:
{
  options = {
    mine.home.anki.enable = lib.mkEnableOption "enable anki";
  };

  config = lib.mkIf config.mine.home.anki.enable {
    home.packages = [
      (pkgs.anki.withAddons [ pkgs.ankiAddons.anki-connect ])
    ];
  };
}
