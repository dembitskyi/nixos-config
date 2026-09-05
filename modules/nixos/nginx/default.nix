{
  lib,
  config,
  pkgs,
  ...
}:
let
  # Self-signed throwaway cert for the default 444 trap vhost. Generated at
  # build time so no private key is committed to the public repo.
  ngix-cert-files = pkgs.runCommand "nginx-dummy-cert" { nativeBuildInputs = [ pkgs.openssl ]; } ''
    mkdir -p $out/etc/nginx/conf
    openssl req -x509 -newkey rsa:2048 -keyout $out/etc/nginx/conf/dummy.key \
      -out $out/etc/nginx/conf/dummy.crt -days 3650 -nodes \
      -subj "/CN=localhost" 2>/dev/null
    chmod 600 $out/etc/nginx/conf/dummy.key
    chmod 644 $out/etc/nginx/conf/dummy.crt
  '';
in
{

  options = {
    mine.nginx.enable = lib.mkEnableOption "enable nginx server";
  };

  config = lib.mkIf config.mine.nginx.enable {

    environment.systemPackages = [ ngix-cert-files ];
    services.nginx = {
      enable = true;
      logError = "stderr warn";

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
