{ lib, config, ... }:
{

  options = {
    mine.below.enable = lib.mkEnableOption "below: per-cgroup (systemd unit) CPU/memory/pressure monitor that records history for replay";
  };

  config = lib.mkIf config.mine.below.enable {
    # The NixOS module replaces upstream's `--compress --retain-for-s` with nothing.
    services.below = {
      enable = true;
      compression.enable = true;
      retention = {
        time = 7 * 24 * 3600;
        size = 10 * 1024 * 1024 * 1024;
      };
    };
  };

}
