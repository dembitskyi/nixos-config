{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.home.alacritty.enable = lib.mkEnableOption "enable alacritty term";
  };

  config = lib.mkIf config.mine.home.alacritty.enable {
    programs.alacritty = {
      enable = true;

      # custom settings
      settings = {
        env.TERM = "xterm-256color";
        terminal = {
          osc52 = "CopyPaste";
          shell = {
            program = "${pkgs.tmux}/bin/tmux";
            args = [
              "new-session"
              "-A"
              "-D"
              "-s"
              "main"
            ];
          };
        };
        font = {
          size = 12;
        };
      };
    };
  };
}
