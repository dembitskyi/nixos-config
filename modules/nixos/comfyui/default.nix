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
      acceleration = "cuda";
      package = pkgs.comfyui;
      host = "127.0.0.1";
      # models = builtins.attrValues pkgs.nixified-ai.models;
      models = lib.attrsets.attrVals [
        # Commented models are gated and require special tokens to access
        # "christmas-couture-lora"
        # "flux-ae"
        # "flux-text-encoder-1"
        # "flux1-dev-q4_0"
        "hyper-sd15-1step-lora"
        "ltx-video"
        "stable-diffusion-v1-5"
        "t5-v1_1-xxl-encoder"
        "t5xxl_fp16"
        "sams"
        "ultrarealistic-lora"
      ] pkgs.nixified-ai.models;
      customNodes = lib.attrValues pkgs.comfyuiCustomNodes;
    };
  };
}
