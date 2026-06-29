{
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
      inherit (variables) username;
      homeDirectory = "/${variables.homePrefix}/${variables.username}";
      sessionVariables = {
        EDITOR = variables.editor;
      };

      stateVersion = "25.05";
    };
    # Preserve pre-26.05 HM behavior; new default is `false`.
    xdg.userDirs.setSessionVariables = true;
    # Nicely reload system units when changing configs
    systemd.user.startServices = "sd-switch";
  };
}
