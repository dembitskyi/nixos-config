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
        # Alacritty ignores tmux's modifyOtherKeys request and sends
        # Shift+Enter as a plain Enter. The CSI u form lets tmux pass it on
        # (as Enter to programs that did not ask for modified keys).
        keyboard.bindings = [
          {
            key = "Return";
            mods = "Shift";
            chars = builtins.fromJSON ''"\u001b[13;2u"'';
          }
        ];
      };
    };
  };
}
