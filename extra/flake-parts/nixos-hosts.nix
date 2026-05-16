{ nixpkgs-patcher }:
{
  self,
  inputs,
  lib,
  withSystem,
  config,
  ...
}:
{
  options = {
    nixos-hosts = {
      hosts = lib.mkOption {
        type = lib.types.attrsOf (
          lib.types.submodule {
            options = {
              system = lib.mkOption {
                type = lib.types.str;
                description = "The system architecture (e.g., x86_64-linux)";
              };

              modules = lib.mkOption {
                type = lib.types.listOf lib.types.deferredModule;
                default = [ ];
                description = "NixOS modules to include for this host";
              };

              specialArgs = lib.mkOption {
                default = { };
                internal = true;
                description = ''
                  Externally provided module arguments that can't be modified from
                  within a configuration, but can be used in module imports.
                '';
              };
              nixpkgsInput = lib.mkOption {
                type = lib.types.raw;
                default = inputs.nixpkgs;
                internal = true;
              };
              nixpkgsPatches = lib.mkOption {
                type = lib.types.listOf lib.types.raw;
                default = [ ];
                internal = true;
              };
              pkgsArgs = lib.mkOption {
                type = lib.types.nullOr lib.types.attrs;
                default = null;
                internal = true;
              };
            };
          }
        );
        default = { };
        description = "Host configurations to build";
      };

      sharedModules = lib.mkOption {
        type = lib.types.listOf lib.types.deferredModule;
        default = [ ];
        description = "Modules shared across all hosts";
      };
    };
  };

  config =
    let
      cfg = config.nixos-hosts;

      # Helper function to create a NixOS configuration with nixpkgs-patcher
      mkNixosSystem =
        _hostname: hostConfig:
        let
          inherit (hostConfig) nixpkgsInput nixpkgsPatches;
          usePatcher = nixpkgsPatches != [ ];
          patchedNixpkgs =
            if usePatcher then
              nixpkgs-patcher.lib.patchNixpkgs {
                inherit inputs;
                nixpkgs = nixpkgsInput;
                patches = _: nixpkgsPatches;
                system = hostConfig.system;
              }
            else
              nixpkgsInput;
          systemLib = if usePatcher then nixpkgs-patcher.lib else nixpkgsInput.lib;
          nixosArgs = {
            inherit (hostConfig) system;

            # Pass inputs and self via specialArgs (same as easy-hosts did)
            specialArgs = {
              inherit inputs self;
            }
            // hostConfig.specialArgs;

            modules =
              cfg.sharedModules
              ++ hostConfig.modules
              ++ [
                # Module to provide self' and inputs' using withSystem
                {
                  _module.args = withSystem hostConfig.system (
                    {
                      self',
                      inputs',
                      ...
                    }:
                    {
                      inherit self' inputs';
                    }
                  );
                }
              ];
          }
          // lib.optionalAttrs usePatcher {
            nixpkgsPatcher = {
              inherit inputs;
              nixpkgs = nixpkgsInput;
              patches = _: nixpkgsPatches;
            };
          }
          // lib.optionalAttrs (hostConfig.pkgsArgs != null) {
            pkgs = import patchedNixpkgs hostConfig.pkgsArgs;
          };
        in
        systemLib.nixosSystem nixosArgs;
    in
    {
      flake.nixosConfigurations = lib.mapAttrs mkNixosSystem cfg.hosts;
    };
}
