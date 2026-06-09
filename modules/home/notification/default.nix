{
  pkgs,
  config,
  lib,
  ...
}:
let
  cfg = config.mine.home.notification;

  notificationMonitorPython =
    let
      python = pkgs.python313.withPackages (ps: [ ps.dbus-next ]);
    in
    "${python}/bin/python3 ${./notification-monitor.py}";
in
{

  options = {
    mine.home.notification = {
      enable = lib.mkEnableOption "enable custom notifications";

      hook = {
        enable = lib.mkEnableOption "enable notification hook service";

        command = lib.mkOption {
          type = lib.types.nullOr lib.types.path;
          default = null;
          description = ''
            Script to run on every notification.
            Receives three arguments: app_name, summary, body.
            When null, the monitor only logs notifications to journald.
          '';
        };
      };
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        # Periodic break notifications via `ianny` are disabled —
        # eyeblink-monitor handles eye-strain reminders better.
      }

      (lib.mkIf cfg.hook.enable {
        systemd.user.services.notification-hook = {
          Unit = {
            Description = "Notification hook monitor";
            After = [ "graphical-session.target" ];
            PartOf = [ "graphical-session.target" ];
          };

          Install = {
            WantedBy = [ "graphical-session.target" ];
          };

          Service = {
            ExecStart =
              if cfg.hook.command != null then
                "${notificationMonitorPython} ${cfg.hook.command}"
              else
                notificationMonitorPython;
            Restart = "on-failure";
            RestartSec = 5;
          };
        };
      })
    ]
  );
}
