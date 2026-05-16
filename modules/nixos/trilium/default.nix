{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.trilium.enable = lib.mkEnableOption "enable trilium server";
  };

  config = lib.mkIf config.mine.trilium.enable {
    services.trilium-server = {
      enable = true;
      package = pkgs.trilium-next-server;
      host = "127.0.0.1";
      port = config.variables.trilium-port;
      dataDir = "/persistent/var/lib/trilium";
      nginx = {
        enable = true;
        hostName = "notes.vmserver.vnet";
      };
    };
  };
}
