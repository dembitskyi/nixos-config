{
  pkgs,
  config,
  lib,
  ...
}:
let
  cfg = config.mine.home.notification;

  iannyConfig = (pkgs.formats.toml { }).generate "config.toml" {
    timer = {
      ignore_idle_inhibitors = true;
      idle_timeout = 240;
      long_break_duration = 240;
      long_break_timeout = 3840;
      short_break_duration = 120;
      short_break_timeout = 1200;
    };
    notification = {
      show_progress_bar = true;
      minimum_update_delay = 1;
    };
  };

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

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      # Periodic rest notification.
      home.packages = with pkgs; [
        ianny
      ];

      xdg.configFile."io.github.zefr0x.ianny/config.toml".source = iannyConfig;
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
            if cfg.hook.command != null
            then "${notificationMonitorPython} ${cfg.hook.command}"
            else notificationMonitorPython;
          Restart = "on-failure";
          RestartSec = 5;
        };
      };
    })
  ]);
}
