{
  lib,
  config,
  ...
}:
{

  options = {
    mine.samba.enable = lib.mkEnableOption "enable samba server";
  };

  config = lib.mkIf config.mine.samba.enable {
    services.samba = {
      enable = true;
      openFirewall = true;

      settings.global = {
        "map to guest" = "Never"; # Disable guest access
        "server min protocol" = "SMB2_02";
        "ntlm auth" = "yes"; # Enable NTLM authentication
        security = "user";
      };

      settings.shared = {
        path = "/srv/shared";
        browseable = true;
        writable = true;
        validUsers = [ "${config.variables.username}" ]; # Only allow this user
        guestOk = false;
        forceUser = "${config.variables.username}"; # Force all access under 'myuser' system account
      };
    };

    systemd.tmpfiles.rules = [
      "d /srv/shared 0770 ${config.variables.username} ${config.variables.username} -"
    ];
  };
}
