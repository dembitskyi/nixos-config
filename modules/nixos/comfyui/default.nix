{
  lib,
  config,
  pkgs,
  ...
}:
{
  options = {
    mine.comfyui.enable = lib.mkEnableOption "enable comfyui service";
  };

  config = lib.mkIf config.mine.comfyui.enable {
    services.nginx = {
      enable = true;
      virtualHosts."ai.vmserver.vnet" = {
        locations."/" = {
          proxyPass = "http://127.0.0.1:8188";
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

    services.comfyui = {
      enable = true;
      package = pkgs.comfyui;
      # Upstream binds to localhost; nginx above reverse-proxies port 8188.
      listen = [ "127.0.0.1" ];
    };
  };
}
