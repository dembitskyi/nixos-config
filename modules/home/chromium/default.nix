{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.home.chromium.enable = lib.mkEnableOption "enable chromium browser";
  };

  config = lib.mkIf config.mine.home.chromium.enable {
    programs.chromium = {
      enable = true;
      package = pkgs.chromium.override { enableWideVine = true; };
      commandLineArgs = [
        "--enable-features=VaapiVideoDecoder,VaapiVideoEncoder,WaylandWindowDecorations"
      ];
    };
  };
}
