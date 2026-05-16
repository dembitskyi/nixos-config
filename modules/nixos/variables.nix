{ lib, ... }:
with lib;
{
  options.variables = {
    username = mkOption {
      type = types.str;
      description = "Primary user account name.";
    };

    homePrefix = mkOption {
      type = types.str;
      default = "home";
      description = "Home directory prefix (e.g. 'home' produces /home/<username>).";
    };

    hostname = mkOption {
      type = types.str;
      default = "nixos";
      description = "System hostname.";
    };

    initialHashedPassword = mkOption {
      type = types.str;
      default = "";
      description = "Initial hashed password for the primary user.";
    };

    email = mkOption {
      type = types.str;
      default = "";
      description = "User email address.";
    };

    pretty_name = mkOption {
      type = types.str;
      default = "";
      description = "Full display name.";
    };

    editor = mkOption {
      type = types.str;
      default = "nvim";
      description = "Default text editor.";
    };

    ollama-port = mkOption {
      type = types.port;
      default = 11434;
      description = "Ollama service port.";
    };

    open-webui-port = mkOption {
      type = types.port;
      default = 8087;
      description = "Open WebUI port.";
    };

    trilium-port = mkOption {
      type = types.port;
      default = 12783;
      description = "Trilium Notes port.";
    };

    filebrowser-port = mkOption {
      type = types.port;
      default = 10000;
      description = "Filebrowser port.";
    };

    pinnedTrayApps = mkOption {
      type = with types; listOf str;
      default = [ ];
      description = "A list of tray apps that are pinned.";
    };

    qb-enableWideVine = mkOption {
      type = types.bool;
      default = true;
      description = "Enable WideVine in qutebrowser.";
    };
  };
}
