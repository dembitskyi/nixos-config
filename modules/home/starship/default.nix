{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.home.starship.enable = lib.mkEnableOption "enable starship";
  };

  config = lib.mkIf config.mine.home.starship.enable {
    programs.starship = {
      enable = true;
      # custom settings
      settings = {
        add_newline = false;
        aws.disabled = true;
        gcloud.disabled = true;
        line_break.disabled = true;
      };
    };
  };
}
