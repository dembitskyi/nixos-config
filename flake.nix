{
  description = "Public NixOS modules, overlays, and packages";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # Pins playwright-mcp to 0.0.76.
    nixpkgs-playwright-mcp.url = "github:NixOS/nixpkgs/e73de5be04e0eff4190a1432b946d469c794e7b4";
    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-root.url = "github:srid/flake-root";
    nixpkgs-patcher.url = "github:gepbird/nixpkgs-patcher";
    nix-colors.url = "github:misterio77/nix-colors";

    hyprland.url = "git+https://github.com/hyprwm/Hyprland?submodules=1&rev=b65714e3b8e123fb2febd507905d25fa6abd0400";
    hyprland-v0_53_3.url = "github:hyprwm/Hyprland/dd220efe7b1e292415bd0ea7161f63df9c95bfd3";

    catppuccin-sioyek = {
      url = "github:catppuccin/sioyek";
      flake = false;
    };

    catppuccin-qutebrowser = {
      url = "github:catppuccin/qutebrowser";
      flake = false;
    };

    thunderbird-catppuccin = {
      url = "github:catppuccin/thunderbird";
      flake = false;
    };
    mkdocs-catppuccin = {
      url = "github:ruslanlap/mkdocs-catppuccin";
      flake = false;
    };
    noctalia-plugins = {
      url = "github:noctalia-dev/noctalia-plugins/bff44cbfe4f7347ec90727cff08e35975e66d42a";
      flake = false;
    };
    noctalia = {
      url = "github:noctalia-dev/noctalia-shell/759454d2d5bce9be7dea982818700140335ed047";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    eyeblink-monitor = {
      url = "github:dembitskyi/eyeblink-monitor";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixified-ai.url = "github:dembitskyi/nixified-ai-flake";

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
          # NixOS module set that can be imported wholesale. Injects the public
          # flake's own inputs as `ncInputs` so consumers don't pass them.
          nixosModules.default = {
            imports = [
              ./modules/nixos
              inputs.nixified-ai.nixosModules.comfyui
            ];
            _module.args.ncInputs = inputs;
          };

          # Home-manager module set that can be imported wholesale. Injects the
          # public flake's own inputs as `ncInputs` so consumers don't pass them.
          homeModules.default = {
            imports = [
              ./modules/home
              inputs.nixvim-custom.homeModules.default
              inputs.eyeblink-monitor.homeManagerModules.default
              inputs.noctalia.homeModules.default
            ];
            _module.args.ncInputs = inputs;
          };

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
