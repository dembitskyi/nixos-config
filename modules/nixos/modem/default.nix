{
  lib,
  config,
  pkgs,
  ...
}:
let
  setupModemEM7455 = pkgs.writeShellScriptBin "setupModem" ''
    #!/bin/bash
    set -x
    DEVICE_ID=$1
    DEVICE_PATH="/dev/ttyEM7455-3"
    if [[ $DEVICE_ID == "3" ]]; then
      ${pkgs.coreutils}/bin/sleep 300  # Wait for modem to fully initialize
      echo -e 'AT+CPMS="ME","ME","ME"\r' > $DEVICE_PATH
      echo -e 'AT+CPMS?\r' > $DEVICE_PATH
      echo "EM7455: Custom setup completed for device $DEVICE_PATH"
    fi
  '';

  setupModemEC25 = pkgs.writeShellScriptBin "setupModem" ''
    #!/bin/bash
    set -x
    DEVICE_ID=$1
    DEVICE_PATH="/dev/ttyEC25-3"
    if [[ $DEVICE_ID == "3" ]]; then
      ${pkgs.coreutils}/bin/sleep 300  # Wait for modem to fully initialize
      echo -e 'AT+CPMS="ME","ME","ME"\r' > $DEVICE_PATH
      echo -e 'AT+CPMS?\r' > $DEVICE_PATH
      echo "EC25: Custom setup completed for device $DEVICE_PATH"
    fi
  '';
in
{

  options = {
    mine.modem.enable = lib.mkEnableOption "enable Modem Support";
  };

  config = lib.mkIf config.mine.modem.enable {
    services.dbus.packages = [ pkgs.modemmanager ];
    systemd.services.ModemManager.enable = true;
    networking.modemmanager.enable = true;
    security.polkit.enable = true;

    environment.systemPackages = with pkgs; [
      modem-manager-gui
      libqmi
      libmbim
    ];

    services.udev.extraRules = ''
      # All EM7455 AT ports → ttyEM7455-N (0,1,2...)
      ACTION=="add" SUBSYSTEM=="tty", ATTRS{idVendor}=="1199", ATTRS{idProduct}=="9071", \
        SYMLINK+="ttyEM7455-%n", MODE="0666", GROUP="dialout", \
        TAG+="systemd", ENV{SYSTEMD_WANTS}="modem-em7455-init@%n.service", ENV{ID_MM_DEVICE_IGNORE}="1"

      # Quectel Wireless Solutions Co., # Ltd. EC25 LTE modem
      ACTION=="add" SUBSYSTEM=="tty", ATTRS{idVendor}=="2c7c", ATTRS{idProduct}=="0125", \
        SYMLINK+="ttyEC25-%n", MODE="0666", GROUP="dialout", \
        TAG+="systemd", ENV{SYSTEMD_WANTS}="modem-ec25-init@%n.service", ENV{ID_MM_DEVICE_IGNORE}="1"
    '';

    systemd.services."modem-em7455-init@" = {
      description = "EM7455 Modem Setup Service";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${setupModemEM7455}/bin/setupModem %i";
      };
    };

    systemd.services."modem-ec25-init@" = {
      description = "EC25 Modem Setup Service";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${setupModemEC25}/bin/setupModem %i";
      };
    };

    systemd.services.ModemManager.wantedBy = [
      "multi-user.target"
      "network.target"
    ];
  };
}
