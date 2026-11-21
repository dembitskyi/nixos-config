# Antigravity CLI sessions (sessions.nix).
{
  lib,
  config,
  pkgs,
  ...
}:
{
  options.mine.ai-sandbox.antigravity.enable =
    lib.mkEnableOption "Antigravity CLI sessions in the AI sandbox";

  config = lib.mkIf config.mine.ai-sandbox.antigravity.enable {
    mine.ai-sandbox.sessions.antigravity = {
      title = "Antigravity CLI";
      command = lib.getExe pkgs.antigravity-cli;
      env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
      args = [ "--dangerously-skip-permissions" ];
      backends.google = { };
      slots.s1.backend = "google";
    };
  };
}
