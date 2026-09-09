{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.parallels-guest;
  userHome = "/${config.variables.homePrefix}/${config.variables.username}";
  workspacePath = "${userHome}/.local/state/ai-sandbox/workspace";
in
{
  options.mine.parallels-guest = {
    enable = lib.mkEnableOption "Parallels guest integration";

    sharedPath = lib.mkOption {
      type = lib.types.str;
      default = "/mnt/psf/Downloads";
      description = "Parallels shared folder path to prepare on the guest.";
    };

    clipboard.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to run the Parallels clipboard sharing service.";
    };

    aiSandboxBind.enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to bind the Parallels shared folder into the AI sandbox.";
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        systemd.tmpfiles.rules = [
          "d /mnt/psf 0755 root root -"
          "d ${cfg.sharedPath} 0755 root root -"
        ];

        home-manager.users.${config.variables.username} = hmArgs: {
          home.file = {
            "Shared".source = hmArgs.config.lib.file.mkOutOfStoreSymlink cfg.sharedPath;
            ".local/state/ai-sandbox/workspace/Shared".source =
              hmArgs.config.lib.file.mkOutOfStoreSymlink cfg.sharedPath;
          };
        };
      }

      (lib.mkIf cfg.clipboard.enable {
        home-manager.users.${config.variables.username}.systemd.user.services.prlcp = {
          Unit = {
            Description = "Parallels clipboard sharing";
            After = [ "graphical-session.target" ];
            PartOf = [ "graphical-session.target" ];
          };

          Install = {
            WantedBy = [ "graphical-session.target" ];
          };

          Service = {
            ExecStart = "${pkgs.prl-tools}/bin/prlcp";
            Restart = "on-failure";
            RestartSec = 3;
          };
        };
      })

      (lib.mkIf cfg.aiSandboxBind.enable {
        home-manager.users.${config.variables.username} = {
          systemd.user.tmpfiles.rules = [
            "d ${workspacePath} 0755 - - -"
          ];

          systemd.user.services.ai-sandbox.Service.BindPaths = [
            "-${cfg.sharedPath}:${cfg.sharedPath}"
          ];
        };
      })
    ]
  );
}
