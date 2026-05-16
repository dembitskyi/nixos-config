{ lib, config, ... }:
let
  open-webuiPort = config.variables.open-webui-port;
  ollama-port = config.variables.ollama-port;
in
{
  options = {
    mine.open-webui.enable = lib.mkEnableOption "enable open-webui";
  };

  config = lib.mkIf config.mine.open-webui.enable {
    services.nginx = {
      enable = true;
      virtualHosts."chat.vmserver.vnet" = {
        locations."/" = {
          proxyPass = "http://127.0.0.1:${toString open-webuiPort}/";
          extraConfig = ''
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
          '';
        };
        extraConfig = ''
          client_max_body_size 0;
        '';
      };
    };

    services.open-webui = {
      enable = true;
      host = "0.0.0.0";
      port = open-webuiPort;
      stateDir = "/var/lib/open-webui"; # open-webui nixpkgs default
      environment = {
        ANONYMIZED_TELEMETRY = "False";
        DO_NOT_TRACK = "True";
        SCARF_NO_ANALYTICS = "True";
        OLLAMA_API_BASE_URL = "http://127.0.0.1:${toString ollama-port}";
        WEBUI_AUTH = "False"; # disable authentication
      };
    };
  };
}
