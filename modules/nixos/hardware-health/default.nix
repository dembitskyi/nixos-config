# Disk health and temperatures from well-known tools: smartd reports SMART
# failures and NVMe over-temperature (journal + desktop), and Prometheus (when
# enabled, e.g. by mine.usage) records temperatures: node_exporter's hwmon
# collector covers CPU/board/RAM/NVMe, nvidia-gpu-exporter the GPU.
{
  lib,
  config,
  ...
}:
let
  cfg = config.mine.hardware-health;
  prom = config.services.prometheus;
in
{
  options.mine.hardware-health = {
    enable = lib.mkEnableOption "smartd disk health warnings and temperature metrics";
    nvidia = lib.mkEnableOption "NVIDIA GPU metrics through nvidia-gpu-exporter";
  };

  config = lib.mkIf cfg.enable {
    services.smartd = {
      enable = true;
      # All SMART checks; journal info at 70 °C, critical at 80 °C.
      defaults.autodetected = "-a -W 0,70,80";
      # Warnings also reach the desktop (earlyoom enables systembus-notify too).
      notifications.systembus-notify.enable = true;
    };

    services.prometheus = lib.mkIf prom.enable {
      exporters.nvidia-gpu = lib.mkIf cfg.nvidia {
        enable = true;
        listenAddress = "127.0.0.1";
      };
      scrapeConfigs = lib.optional cfg.nvidia {
        job_name = "nvidia-gpu";
        static_configs = [ { targets = [ "127.0.0.1:${toString prom.exporters.nvidia-gpu.port}" ]; } ];
      };
    };
  };
}
