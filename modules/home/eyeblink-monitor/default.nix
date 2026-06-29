{
  lib,
  config,
  pkgs,
  ncInputs,
  ...
}:
let
  cfg = config.mine.home.eyeblink-monitor;
in
{
  options.mine.home.eyeblink-monitor = {
    enable = lib.mkEnableOption "eyeblink-monitor blink detector with Hyprland screen dimming";

    settings = lib.mkOption {
      type = lib.types.attrs;
      default = {
        detection = {
          ear_threshold = 0.21;
          camera_index = 1;
        };
        alert.warning_seconds = 10;
        nudge = {
          scope = "all";
          target_dim = 0.35;
          fade_ms = 800;
          escalation = [
            [
              20
              0.80
            ]
          ];
        };
      };
      description = "Settings passed to programs.eyeblink-monitor.settings.";
    };

    extraArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Extra CLI arguments passed to eyeblink-monitor.";
      example = [ "--show-preview" ];
    };
  };

  config = lib.mkIf cfg.enable {
    programs.eyeblink-monitor = {
      enable = true;
      package = ncInputs.eyeblink-monitor.packages.${pkgs.stdenv.hostPlatform.system}.default;
      inherit (cfg) settings;
      inherit (cfg) extraArgs;
    };
  };
}
