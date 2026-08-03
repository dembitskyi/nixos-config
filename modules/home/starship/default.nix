{
  lib,
  config,
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
        # Drop the default ❄️ symbol (its U+FE0F emoji width breaks readline redraw); keep the impure/pure indicator.
        nix_shell.symbol = "";
      };
    };
  };
}
