{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.home.chromium;
in
{
  options = {
    mine.home.chromium = {
      enable = lib.mkEnableOption "enable chromium browser";

      remoteDebugging = {
        enable = lib.mkEnableOption "Chromium remote debugging for the existing browser profile";

        address = lib.mkOption {
          type = lib.types.str;
          default = "127.0.0.1";
          description = "Address used by Chromium's remote debugging server.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 9224;
          description = "Port used by Chromium's remote debugging server.";
        };
      };
    };
  };

  config = lib.mkIf cfg.enable {
    programs.chromium = {
      enable = true;
      package = pkgs.chromium.override { enableWideVine = true; };
      commandLineArgs = [
        "--enable-features=VaapiVideoDecoder,VaapiVideoEncoder,WaylandWindowDecorations"
      ]
      ++ lib.optionals cfg.remoteDebugging.enable [
        "--remote-debugging-address=${cfg.remoteDebugging.address}"
        "--remote-debugging-port=${toString cfg.remoteDebugging.port}"
      ];
    };
  };
}
