{
  lib,
  config,
  ...
}:
{

  options = {
    mine.home.kitty.enable = lib.mkEnableOption "enable kitty term";
  };

  config = lib.mkIf config.mine.home.kitty.enable {
    programs.kitty = {
      enable = true;

      # Catppuccin Mocha to match the system Hyprland theme.
      themeFile = "Catppuccin-Mocha";

      font = {
        # Home Manager renders font_family unconditionally when font is set,
        # so name is required alongside size. Hack Nerd Font Mono is installed
        # system-wide (mine.fonts) and already used by the Noctalia bar.
        name = "Hack Nerd Font Mono";
        size = 12;
      };

      settings = {
        enable_audio_bell = false;
        copy_on_select = true;
        scrollback_lines = 10000;
        shell_integration = "enabled";
        linux_display_server = "wayland";
        confirm_os_window_close = 0;

        # The Mocha theme's "white" is dim lavender-gray (foreground #CDD6F4,
        # color7 #BAC2DE), which washes out plain text like `ls -la` output.
        # These apply after the theme include, so they win. Blues are lifted
        # slightly too, since `ls` directories were the hardest to read.
        foreground = "#E8EBF8";
        color7 = "#D5DBF2";
        color15 = "#E8EBF8";
        color4 = "#93B8FD";
        color12 = "#A9C6FF";
      };
    };
  };
}
