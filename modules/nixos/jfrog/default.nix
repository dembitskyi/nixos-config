{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.mine.jfrog;
  userHome = "/${config.variables.homePrefix}/${config.variables.username}";
  confName = "jfrog-cli-conf";
in
{
  options.mine.jfrog = {
    enable = lib.mkEnableOption "declarative JFrog CLI (jf) configuration";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.jfrog-cli;
      defaultText = lib.literalExpression "pkgs.jfrog-cli";
      description = "The JFrog CLI package to install.";
    };

    url = lib.mkOption {
      type = lib.types.str;
      example = "https://artifactory.example.com";
      description = "Base URL of the JFrog platform deployment (no trailing slash).";
    };

    serverId = lib.mkOption {
      type = lib.types.str;
      default = "default";
      description = "Server ID recorded in the generated jf configuration.";
    };

    skills = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "jfrog"
        "jfrog-package-safety-and-download"
      ];
      description = ''
        JFrog agent skills (from jfrog/jfrog-skills) to allow for opencode and
        expose inside the fastmcp sandbox. Set to [ ] to deploy none.
      '';
    };

    userSecret = lib.mkOption {
      type = lib.types.str;
      description = ''
        Name of the sops secret holding the username for basic auth. The secret
        must be declared by the consumer (e.g. in the host's `sops.secrets`).
      '';
    };

    tokenSecret = lib.mkOption {
      type = lib.types.str;
      description = ''
        Name of the sops secret holding the access token / password. The secret
        must be declared by the consumer (e.g. in the host's `sops.secrets`).
      '';
    };

    confPath = lib.mkOption {
      type = lib.types.str;
      internal = true;
      readOnly = true;
      default = config.sops.templates.${confName}.path;
      defaultText = lib.literalExpression ''config.sops.templates."jfrog-cli-conf".path'';
      description = "Path of the rendered jf config, for binding into sandboxes.";
    };

    targetPath = lib.mkOption {
      type = lib.types.str;
      internal = true;
      readOnly = true;
      default = "${userHome}/.jfrog/jfrog-cli.conf.v6";
      description = "Location of the jf config within the user's home.";
    };
  };

  config = lib.mkIf cfg.enable {
    # Render the jf v6 config (JSON) with credentials sourced from sops at
    # runtime, so the token never lands in the Nix store.
    sops.templates.${confName} = {
      content = builtins.toJSON {
        version = "6";
        servers = [
          {
            inherit (cfg) serverId;
            url = "${cfg.url}/";
            artifactoryUrl = "${cfg.url}/artifactory/";
            xrayUrl = "${cfg.url}/xray/";
            user = config.sops.placeholder.${cfg.userSecret};
            password = config.sops.placeholder.${cfg.tokenSecret};
            isDefault = true;
          }
        ];
      };
      owner = config.variables.username;
      mode = "0600";
    };

    home-manager.users.${config.variables.username} = hmArgs: {
      home.packages = [ cfg.package ];

      # Symlink the rendered config into ~/.jfrog so interactive `jf` is
      # configured, while jf keeps writing its locks/state into the real dir.
      home.file.".jfrog/jfrog-cli.conf.v6".source =
        hmArgs.config.lib.file.mkOutOfStoreSymlink cfg.confPath;

      # Provide the official JFrog agent skills and allow them in opencode.
      mine.home.ai-skills.extraSources = lib.mkIf (cfg.skills != [ ]) [
        {
          name = "jfrog";
          url = "https://github.com/jfrog/jfrog-skills";
          layout = "skills-subdir";
        }
      ];
      mine.home.opencode.extraPermissions.skill = lib.genAttrs cfg.skills (_: "allow");
    };
  };
}
