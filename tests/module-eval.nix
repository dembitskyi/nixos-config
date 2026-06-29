# Test that the public NixOS and home modules can be loaded and evaluated.
# Run with: nix eval -f tests/module-eval.nix --impure
let
  flake = builtins.getFlake (builtins.toString ./..);
  nixpkgs = flake.inputs.nixpkgs;

  selfPrime = {
    packages = flake.packages.x86_64-linux or { };
  };

  # Build a NixOS system importing the public modules.
  # Modules behind mkEnableOption that need external deps (comfyui,
  # otterwiki, etc.) are left disabled — they require nixpkgs patches
  # or extra overlays that are provided at host-config level.
  testSystem = nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      # Stubs for options defined by external modules that some public
      # modules conditionally reference (home-manager, comfyui, otterwiki).
      (
        { lib, ... }:
        {
          options.home-manager = lib.mkOption {
            type = lib.types.anything;
            default = { };
          };
          options.services.comfyui = lib.mkOption {
            type = lib.types.anything;
            default = { };
          };
          options.services.otterwiki = lib.mkOption {
            type = lib.types.anything;
            default = { };
          };
          options.sops = lib.mkOption {
            type = lib.types.anything;
            default = { };
          };
          config._module.args = {
            self' = selfPrime;
            inputs' = { };
          };
        }
      )

      flake.nixosModules.default

      {
        boot.loader.grub.devices = [ "/dev/sda" ];
        fileSystems."/" = {
          device = "/dev/sda1";
          fsType = "ext4";
        };
        system.stateVersion = "25.05";
        nixpkgs.config.allowUnfree = true;

        variables = {
          username = "testuser";
          email = "test@example.com";
          pretty_name = "Test User";
        };

        mine = {
          coreutils.enable = true;
          fzf.enable = true;
          fonts.enable = true;
          sound.enable = true;
          ollama.enable = true;
          npm.enable = true;
          trilium.enable = true;
          steam.enable = true;
        };
      }
    ];
  };

  cfg = testSystem.config;

  assertEnabled =
    name: value: if value then "${name}=OK" else throw "${name} should be enabled but is not";

  results = builtins.concatStringsSep ", " [
    (assertEnabled "coreutils" cfg.mine.coreutils.enable)
    (assertEnabled "fzf" cfg.mine.fzf.enable)
    (assertEnabled "fonts" cfg.mine.fonts.enable)
    (assertEnabled "sound" cfg.mine.sound.enable)
    (assertEnabled "ollama" cfg.mine.ollama.enable)
    (assertEnabled "npm" cfg.mine.npm.enable)
    (assertEnabled "trilium" cfg.mine.trilium.enable)
    (assertEnabled "steam" cfg.mine.steam.enable)
    "username=${cfg.variables.username}"
    "ollama-port=${toString cfg.variables.ollama-port}"
  ];
in
"All module tests passed: ${results}"
