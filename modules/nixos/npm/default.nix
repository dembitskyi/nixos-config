{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.npm.enable = lib.mkEnableOption "enable npm";
  };

  config = lib.mkIf config.mine.npm.enable {
    programs.npm.enable = true;
  };
}
