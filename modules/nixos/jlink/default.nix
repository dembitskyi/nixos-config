{
  lib,
  config,
  ...
}:
{

  options = {
    mine.jlink.enable = lib.mkEnableOption "SEGGER J-Link USB access for SWD flashing";
  };

  config = lib.mkIf config.mine.jlink.enable {
    # SEGGER probes enumerate under USB vendor 0x1366. `uaccess` covers a
    # locally-seated session, while `MODE="0666"` keeps the probe reachable
    # from headless/SSH sessions where no seat is assigned (e.g. west flash
    # -r jlink run over SSH). This avoids needing sudo for JLinkExe.
    services.udev.extraRules = ''
      SUBSYSTEM=="usb", ATTR{idVendor}=="1366", MODE="0666", TAG+="uaccess"
    '';
  };
}
