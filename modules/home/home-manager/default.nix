{
  inputs,
  lib,
  config,
  variables,
  ...
}:
{

  options = {
    mine.home.home-manager.enable = lib.mkEnableOption "enable home-manager core config";
  };

  config = lib.mkIf config.mine.home.home-manager.enable {
    home = {
      username = variables.username;
      homeDirectory = "/${variables.homePrefix}/${variables.username}";
      sessionVariables = {
        EDITOR = variables.editor;
      };

      stateVersion = "25.05";
    };
    # Nicely reload system units when changing configs
    systemd.user.startServices = "sd-switch";
  };
}
