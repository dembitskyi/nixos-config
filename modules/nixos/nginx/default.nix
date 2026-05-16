{
  lib,
  config,
  pkgs,
  ...
}:
let
  ngix-cert-files = pkgs.stdenv.mkDerivation {
    name = "nginx cert files";
    src = ./conf;
    dontBuild = true;
    installPhase = ''
      mkdir -p $out/etc/nginx/conf
      cp -r $src/* $out/etc/nginx/conf
    '';
  };
in
{

  options = {
    mine.nginx.enable = lib.mkEnableOption "enable nginx server";
  };

  config = lib.mkIf config.mine.nginx.enable {

    environment.systemPackages = [ ngix-cert-files ];
    services.nginx = {
      enable = true;
      logError = "stderr debug";

      virtualHosts."_" = {
        default = true; # This makes it the default server for unmatched requests
        listen = [
          {
            addr = "0.0.0.0";
            port = 80;
          }
          {
            addr = "0.0.0.0";
            port = 443;
            ssl = true;
          }
        ];
        onlySSL = true;
        sslCertificate = "${ngix-cert-files}/etc/nginx/conf/dummy.crt";
        sslCertificateKey = "${ngix-cert-files}/etc/nginx/conf/dummy.key";
        locations."/" = {
          extraConfig = ''
            return 444;
          '';
        };
      };
    };
    networking.firewall.allowedTCPPorts = [
      80 # HTTP
      443 # HTTPS
    ];
  };
}
