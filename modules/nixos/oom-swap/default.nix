{ lib, config, ... }:
{

  options = {
    mine.oom-swap.enable = lib.mkEnableOption "enable earlyoom and zram swap";
  };

  config = lib.mkIf config.mine.oom-swap.enable {
    systemd.oomd.enable = false;

    zramSwap = {
      enable = true;
      algorithm = "zstd";
      memoryPercent = 10;
    };

    boot.kernel.sysctl = {
      "vm.swappiness" = 180;
      "vm.watermark_boost_factor" = 0;
      "vm.watermark_scale_factor" = 125;
      "vm.page-cluster" = 0;
    };

    services.earlyoom = {
      enable = true;
      enableNotifications = true;
      freeMemThreshold = 10;
      freeSwapThreshold = 10;
    };
  };

}
