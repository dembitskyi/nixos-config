# Test that the public home-manager modules can be loaded and evaluated.
# Run with: nix eval -f tests/home-module-eval.nix --impure
let
  flake = builtins.getFlake (builtins.toString ./..);
  nixpkgs = flake.inputs.nixpkgs;
  pkgs = import nixpkgs {
    system = "x86_64-linux";
    config.allowUnfree = true;
  };

  # Simulate the variables attrset as passed via extraSpecialArgs.
  variables = {
    username = "testuser";
    homePrefix = "home";
    hostname = "testhost";
    email = "test@example.com";
    pretty_name = "Test User";
    editor = "nvim";
    ollama-port = 11434;
    open-webui-port = 8087;
    trilium-port = 12783;
    filebrowser-port = 10000;
    pinnedTrayApps = [ ];
    qb-enableWideVine = false;
  };

  # Minimal home-manager evaluation using lib.evalModules.
  hmEval = pkgs.lib.evalModules {
    modules = [
      # Provide the required module args that home-manager would set up.
      {
        _module.args = {
          inherit pkgs;
          inherit variables;
          inputs = flake.inputs;
          inputs' = { };
          self' = {
            packages = flake.packages.x86_64-linux or { };
          };
          osConfig = { };
        };
      }

      # Declare minimal home-manager options the modules expect.
      (
        { lib, ... }:
        {
          options = {
            home = {
              username = lib.mkOption { type = lib.types.str; default = "testuser"; };
              homeDirectory = lib.mkOption { type = lib.types.str; default = "/home/testuser"; };
              stateVersion = lib.mkOption { type = lib.types.str; default = "25.05"; };
              packages = lib.mkOption {
                type = lib.types.listOf lib.types.package;
                default = [ ];
              };
              file = lib.mkOption {
                type = lib.types.anything;
                default = { };
              };
              sessionVariables = lib.mkOption {
                type = lib.types.anything;
                default = { };
              };
              activation = lib.mkOption {
                type = lib.types.anything;
                default = { };
              };
            };
            programs = lib.mkOption {
              type = lib.types.anything;
              default = { };
            };
            systemd = lib.mkOption {
              type = lib.types.anything;
              default = { };
            };
            services = lib.mkOption {
              type = lib.types.anything;
              default = { };
            };
            xdg = lib.mkOption {
              type = lib.types.anything;
              default = { };
            };
            sops = lib.mkOption {
              type = lib.types.anything;
              default = { };
            };
            targets = lib.mkOption {
              type = lib.types.anything;
              default = { };
            };
          };
        }
      )

      flake.homeModules.default

      # Enable a selection of home modules.
      {
        mine.home = {
          starship.enable = true;
          bash.enable = true;
          tmux.enable = true;
          git.enable = true;
          lazygit.enable = true;
          atuin.enable = true;
        };
      }
    ];
  };

  cfg = hmEval.config;

  assertEnabled =
    name: value:
    if value then
      "${name}=OK"
    else
      throw "${name} should be enabled but is not";

  results = builtins.concatStringsSep ", " [
    (assertEnabled "starship" cfg.mine.home.starship.enable)
    (assertEnabled "bash" cfg.mine.home.bash.enable)
    (assertEnabled "tmux" cfg.mine.home.tmux.enable)
    (assertEnabled "git" cfg.mine.home.git.enable)
    (assertEnabled "lazygit" cfg.mine.home.lazygit.enable)
    (assertEnabled "atuin" cfg.mine.home.atuin.enable)
  ];
in
"All home module tests passed: ${results}"
