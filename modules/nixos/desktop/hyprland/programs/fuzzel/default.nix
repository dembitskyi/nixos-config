{
  config,
  lib,
  ...
}:
{
  config = lib.mkIf config.mine.hyprland.enable {
    home-manager.users.${config.variables.username} = {
      programs.fuzzel = {
        enable = true;
        settings = {
          main = {
            font = "monospace:size=12";
            icon-theme = "Papirus-Dark";
            icons-enabled = "yes";
            terminal = "alacritty -e";
            width = 45;
            lines = 12;
            horizontal-pad = 24;
            vertical-pad = 16;
            inner-pad = 10;
            line-height = 24;
          };
          border = {
            width = 2;
            radius = 10;
          };
          colors = {
            background = "1e1d2fee";
            text = "c6d0f5ff";
            prompt = "f2d5cfff";
            input = "c6d0f5ff";
            match = "ca9ee6ff";
            selection = "ca9ee6ff";
            selection-text = "1e1d2fff";
            selection-match = "1e1d2fff";
            border = "ca9ee6ff";
          };
        };
      };
    };
  };
}
