{
  description = "Public NixOS modules, overlays, and packages";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-root.url = "github:srid/flake-root";
    nixpkgs-patcher.url = "github:gepbird/nixpkgs-patcher";
    nix-colors.url = "github:misterio77/nix-colors";

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";

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
          inputs.pre-commit-hooks.flakeModule
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
            { ... }:
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

                    # Patterns are matched against paths relative to the repo root.
                    settings.global.excludes = [
                      # Vendored adi1090x rofi themes (rasi + launcher scripts).
                      "modules/nixos/desktop/hyprland/programs/rofi/**"
                      # Dummy TLS material for nginx test configs.
                      "*.crt"
                      "*.key"
                      "*.patch"
                      "*.diff"
                    ];

                    programs = {
                      nixfmt.enable = true;
                      nixfmt.package = pkgs.nixfmt;
                      deadnix.enable = true;
                      statix.enable = true;
                      shfmt.enable = true;
                      shellcheck.enable = true;
                      ruff-format.enable = true;
                      ruff-check.enable = true;
                      mdformat.enable = true;
                      yamlfmt.enable = true;
                    };

                    # Shebang scripts with no extension; list includes merge with
                    # each formatter's defaults rather than replacing them.
                    settings.formatter = {
                      shellcheck.includes = [ "**/clip-text-refiner" ];
                      shfmt.includes = [ "**/clip-text-refiner" ];
                      ruff-check.includes = [ "**/qute-keepassxc" ];
                      ruff-format.includes = [ "**/qute-keepassxc" ];
                      # Prompt files are model inputs; keep them verbatim.
                      mdformat.excludes = [ "**/prompts/**" ];
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

              # Patterns are matched against paths relative to the repo root.
              settings.global.excludes = [
                # Vendored adi1090x rofi themes (rasi + launcher scripts).
                "modules/nixos/desktop/hyprland/programs/rofi/**"
                # Dummy TLS material for nginx test configs.
                "*.crt"
                "*.key"
                "*.patch"
                "*.diff"
              ];

              programs = {
                nixfmt.enable = true;
                nixfmt.package = pkgs.nixfmt;
                deadnix.enable = true;
                statix.enable = true;
                shfmt.enable = true;
                shellcheck.enable = true;
                ruff-format.enable = true;
                ruff-check.enable = true;
                mdformat.enable = true;
                yamlfmt.enable = true;
              };

              # Shebang scripts with no extension; list includes merge with each
              # formatter's defaults rather than replacing them.
              settings.formatter = {
                shellcheck.includes = [ "**/clip-text-refiner" ];
                shfmt.includes = [ "**/clip-text-refiner" ];
                ruff-check.includes = [ "**/qute-keepassxc" ];
                ruff-format.includes = [ "**/qute-keepassxc" ];
                # Prompt files are model inputs; keep them verbatim.
                mdformat.excludes = [ "**/prompts/**" ];
              };
            };

            formatter = config.treefmt.build.wrapper;

            pre-commit.settings.hooks = {
              treefmt = {
                enable = true;
                package = config.treefmt.build.wrapper;
              };
            };

            devShells.default = pkgs.mkShell {
              inputsFrom = [ config.pre-commit.devShell ];
              packages = [ config.treefmt.build.wrapper ];
              # Share the pre-push gate with every clone via tracked hooks.
              shellHook = "git config core.hooksPath .githooks";
            };

            checks = {
              formatting = config.treefmt.build.check inputs.self;
              git-hooks = config.pre-commit.settings.run;
            };
          };
      }
    );
}
