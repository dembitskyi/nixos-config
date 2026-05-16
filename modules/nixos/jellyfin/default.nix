{
  lib,
  config,
  ...
}:
{

  options = {
    mine.jellyfin.enable = lib.mkEnableOption "enable jellyfin";
  };

  config = lib.mkIf config.mine.jellyfin.enable {
    services.jellyfin = {
      enable = true;
      openFirewall = true;
    };

    services.nginx = {
      enable = true;
      virtualHosts."media.vmserver.vnet" = {
        locations."/" = {
          proxyPass = "http://127.0.0.1:8096";
          proxyWebsockets = true;
        };
      };
    };
  };
}
