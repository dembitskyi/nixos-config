{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.home.prlcp.enable = lib.mkEnableOption "enable Parallels clipboard sharing service";
  };

  config = lib.mkIf config.mine.home.prlcp.enable {
    systemd.user.services.prlcp = {
      Unit = {
        Description = "Parallels clipboard sharing";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
      };

      Install = {
        WantedBy = [ "graphical-session.target" ];
      };

      Service = {
        ExecStart = "${pkgs.prl-tools}/bin/prlcp";
        Restart = "on-failure";
        RestartSec = 3;
      };
    };
  };
}
