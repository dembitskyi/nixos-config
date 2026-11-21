# Copilot CLI sessions (sessions.nix).
{
  lib,
  config,
  pkgs,
  ...
}:
{
  options.mine.ai-sandbox.copilot.enable =
    lib.mkEnableOption "Copilot CLI sessions in the AI sandbox";

  config = lib.mkIf config.mine.ai-sandbox.copilot.enable {
    mine.ai-sandbox.sessions.copilot = {
      title = "Copilot CLI";
      command = lib.getExe pkgs.github-copilot-cli;
      # "true" also trusts the folder.
      env.COPILOT_ALLOW_ALL = "true";
      args = [ "--yolo" ];
      backends.github = { };
      slots.s1.backend = "github";
    };
  };
}
