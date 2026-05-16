{
  lib,
  config,
  pkgs,
  variables,
  ...
}:
{

  options = {
    mine.home.atuin.enable = lib.mkEnableOption "enable atuin (history search)";
  };

  config = lib.mkIf config.mine.home.atuin.enable {
    programs.atuin = {
      enable = true;
      flags = [ "--disable-up-arrow" ];
      settings = {
        style = "compact";
        inline_height = 15;
        history_filter = [
          "^(echo|cat).+base64.+"
          "^(z|man|which|dmesg|uname) .*"
        ];
      };
    };
  };
}
