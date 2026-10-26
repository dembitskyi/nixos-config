{
  lib,
  config,
  pkgs,
  ...
}:
let
  ini = "${config.xdg.configHome}/keepassxc/keepassxc.ini";
  set = section: key: value: ''
    run ${lib.getExe pkgs.crudini} --set ${ini} ${section} ${key} ${value}
  '';
in
{

  options = {
    mine.home.keepassxc.enable = lib.mkEnableOption "enable password manager (keepassxc)";
  };

  config = lib.mkIf config.mine.home.keepassxc.enable {
    home.packages = with pkgs; [ keepassxc ];

    # Set in place: KeePassXC keeps writing its own settings.
    home.activation.keepassxc = lib.hm.dag.entryAfter [ "writeBoundary" ] (
      ''
        run mkdir -p ${dirOf ini}
      ''
      + set "Browser" "Enabled" "true"
      + set "GUI" "ShowTrayIcon" "true"
      + set "GUI" "MinimizeToTray" "true"
      + set "GUI" "MinimizeOnStartup" "true"
    );

    systemd.user.services.keepassxc = {
      Unit = {
        Description = "KeePassXC";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        ExecStart = lib.getExe pkgs.keepassxc;
        Restart = "on-failure";
      };
      Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}
