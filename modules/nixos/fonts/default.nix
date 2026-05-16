{
  pkgs,
  lib,
  config,
  ...
}:
{

  options = {
    mine.fonts.enable = lib.mkEnableOption "enable my custom fonts";
  };

  config = lib.mkIf config.mine.fonts.enable {
    fonts = {
      fontDir.enable = true;
      enableDefaultPackages = true;
      packages = with pkgs; [
        noto-fonts-color-emoji
        font-awesome
        hack-font
        nerd-fonts.hack
        nerd-fonts.blex-mono
        source-sans-pro
        ubuntu-classic
        liberation_ttf
      ];
      fontconfig = {
        defaultFonts = {
          serif = [
            "Liberation Serif"
            "Vazirmatn"
          ];
          sansSerif = [
            "Ubuntu"
            "Vazirmatn"
          ];
          monospace = [ "Ubuntu Mono" ];
        };
      };
    };
  };
}
