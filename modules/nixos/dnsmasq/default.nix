{
  lib,
  config,
  ...
}:
{

  options = {
    mine.dnsmasq.enable = lib.mkEnableOption "enable dnsmasq";
  };

  config = lib.mkIf config.mine.dnsmasq.enable {
    services.dnsmasq = {
      enable = true;
      settings = {
        listen-address = "127.0.0.1";
        bind-interfaces = true;
        cache-size = 1000;
        log-queries = true;
        log-facility = "/var/log/dnsmasq.log";
      };
    };

    networking.nameservers = [ "127.0.0.1" ];
    services.resolved.enable = false;
  };
}
