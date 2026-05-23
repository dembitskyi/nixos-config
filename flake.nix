{
  description = "Public NixOS modules, overlays, and packages";

  inputs = {
    nixpkgs.url = "nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-root.url = "github:srid/flake-root";
    nixpkgs-patcher.url = "github:gepbird/nixpkgs-patcher";
    nix-colors.url = "github:misterio77/nix-colors";

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nixvim-custom = {
      url = "github:dembitskyi/nvim.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { flake-parts, ... }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } (
      { ... }:
      {
        imports = [
          inputs.flake-root.flakeModule
          inputs.treefmt-nix.flakeModule
          ./overlays/flake-module.nix
        ];

        systems = [
          "aarch64-linux"
          "x86_64-linux"
        ];

        flake = {
          # NixOS module set that can be imported wholesale.
          nixosModules.default = ./modules/nixos;

          # Home-manager module set that can be imported wholesale.
          homeModules.default = ./modules/home;

          # Flake-parts module that provides the nixos-hosts builder and
          # shared scaffolding (overlays, treefmt).
          flakeModules.default =
            { inputs, ... }:
            {
              imports = [
                inputs.self.flakeModules.nixos-hosts
                inputs.self.flakeModules.overlays
                inputs.self.flakeModules.treefmt
              ];
            };

          flakeModules.nixos-hosts = import ./extra/flake-parts/nixos-hosts.nix {
            inherit (inputs) nixpkgs-patcher;
          };

          flakeModules.overlays = ./overlays/flake-module.nix;

          flakeModules.treefmt =
            { config, ... }:
            {
              imports = [
                inputs.flake-root.flakeModule
                inputs.treefmt-nix.flakeModule
              ];
              perSystem =
                { config, pkgs, ... }:
                {
                  treefmt.config = {
                    inherit (config.flake-root) projectRootFile;
                    package = pkgs.treefmt;
                    programs = {
                      alejandra.enable = true;
                      deadnix.enable = true;
                      statix.enable = true;
                    };
                  };
                  formatter = config.treefmt.build.wrapper;
                };
            };

        };

        perSystem =
          {
            system,
            config,
            pkgs,
            ...
          }:
          {
            _module.args.pkgs = import inputs.nixpkgs {
              inherit system;
              config.allowUnfree = true;
            };

            treefmt.config = {
              inherit (config.flake-root) projectRootFile;
              package = pkgs.treefmt;

              programs = {
                alejandra.enable = true;
                deadnix.enable = true;
                statix.enable = true;
              };
            };

            formatter = config.treefmt.build.wrapper;
          };
      }
    );
}
