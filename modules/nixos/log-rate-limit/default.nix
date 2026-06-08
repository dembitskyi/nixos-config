# Caps systemd-journald ingest rate and on-disk size so a misbehaving driver
# (e.g. xhci_hcd flooding with TRB errors from a flaky USB device) cannot
# saturate CPU on journal processing or fill /var with kernel log spam.
#
# Also tightens kernel.printk_ratelimit for drivers that opt in via
# printk_ratelimited(). Note: this does NOT silence unconditional printks
# such as xhci_warn() — those still need to be caught at the journald layer.
#
# When a source exceeds the rate cap, journald inserts a single
# "Suppressed N messages from ..." entry, so we never silently lose
# visibility into a flood — we just stop storing every line of it.
{ lib, config, ... }:
{

  options = {
    mine.log-rate-limit.enable = lib.mkEnableOption "journald rate limiting and printk hygiene";
  };

  config = lib.mkIf config.mine.log-rate-limit.enable {
    services.journald.extraConfig = ''
      RateLimitIntervalSec=30s
      RateLimitBurst=2000
      SystemMaxUse=2G
      SystemKeepFree=1G
      MaxRetentionSec=14day
    '';

    boot.kernel.sysctl = {
      "kernel.printk_ratelimit" = 5;
      "kernel.printk_ratelimit_burst" = 10;
    };
  };

}
