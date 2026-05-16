{
  lib,
  config,
  pkgs,
  variables,
  ...
}:
{

  options = {
    mine.home.git.enable = lib.mkEnableOption "enable custom git settings";
  };

  config = lib.mkIf config.mine.home.git.enable {
    programs.git.enable = true;
    programs.delta.enable = true;
    programs.delta.enableGitIntegration = true;
    programs.gh.enable = true;
    programs.gh.settings.version = 1;
    programs.gh.settings.git_protocol = "ssh";
  };
}
