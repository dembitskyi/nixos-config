{
  pkgs,
  lib,
  config,
  ...
}:
{
  config = lib.mkIf config.mine.hyprland.enable {
    home-manager.users.${config.variables.username} = {
      programs.rofi = {
        enable = true;
        terminal = "${lib.getExe pkgs.alacritty}";
        plugins = with pkgs; [
          rofi-emoji # https://github.com/Mange/rofi-emoji 🤯
          rofi-games # https://github.com/Rolv-Apneseth/rofi-games 🎮
        ];
        extraConfig = import ./config.nix;
      };
      xdg.configFile."rofi/launchers" = {
        source = ./launchers;
        recursive = true;
      };
      xdg.configFile."rofi/colors" = {
        source = ./colors;
        recursive = true;
      };
    };
  };
}
