{
  lib,
  config,
  pkgs,
  ...
}:
let
  ollamaPort = config.variables.ollama-port;
in
{

  options = {
    mine.ollama.enable = lib.mkEnableOption "enable ollama";
  };

  config = lib.mkIf config.mine.ollama.enable {
    services.nginx = {
      enable = true;
      virtualHosts."ollama.vmserver.vnet" = {
        locations."/" = {
          proxyPass = "http://127.0.0.1:${toString ollamaPort}/";
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

    services.ollama = {
      enable = true;
      package = pkgs.ollama-cuda;
      host = "0.0.0.0";
      port = ollamaPort;
      # default store: /var/lib/ollama/models
      environmentVariables = {
        OLLAMA_DEBUG = "2";
        # OLLAMA_CONTEXT_LENGTH = "120000";
        # OLLAMA_MAX_VRAM = "120G";
        # OLLAMA_GPU_LAYERS = "80";
        OLLAMA_KV_CACHE_TYPE = "q4_0";
        OLLAMA_KEEP_ALIVE = "30m";
        # OLLAMA_FLASH_ATTENTION = "1";
      };
      loadModels = [
        "qwen3-next:80b"
        "qwen2.5-coder:14b"
        "glm-4.7-flash:latest"
        "gemma4:31b"
        "qwen3.6:35b-a3b-q8_0"
      ];
    };
  };
}
