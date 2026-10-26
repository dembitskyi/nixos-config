{
  description = "Public NixOS modules, overlays, and packages";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # Pins playwright-mcp to 0.0.80.
    nixpkgs-playwright-mcp.url = "github:NixOS/nixpkgs/20b1ddd1aa5ace70c9468305030aa4f9ef79671b";

    # opencode pinned via upstream's flake; bump the tag to update. No nixpkgs
    # follows: its node_modules FOD needs upstream's own pinned bun.
    opencode.url = "github:anomalyco/opencode/v2.0.26";

    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-root.url = "github:srid/flake-root";
    nixpkgs-patcher.url = "github:gepbird/nixpkgs-patcher";
    nix-colors.url = "github:misterio77/nix-colors";

    # Hyprland source, pinned to the version nixos-unstable ships. It is built
    # with nixpkgs' recipe, so it links the system's glibc and mesa and comes
    # from cache.nixos.org while both versions agree.
    hyprland = {
      url = "github:hyprwm/Hyprland/v0.56.2";
      flake = false;
    };

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
    eyeblink-monitor = {
      url = "github:dembitskyi/eyeblink-monitor";
      inputs.nixpkgs.follows = "nixpkgs";
    };

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
          # NixOS module set that can be imported wholesale. Injects the public
          # flake's own inputs as `ncInputs` so consumers don't pass them.
          nixosModules.default = {
            imports = [
              ./modules/nixos
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
            ];
            _module.args.ncInputs = inputs;
          };

          # Flake-parts module that builds nixosConfigurations from a host list.
          flakeModules.nixos-hosts = import ./extra/flake-parts/nixos-hosts.nix {
            inherit (inputs) nixpkgs-patcher;
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
                "*.patch"
                "*.diff"
                # Vendored vLLM image overlays are bind-mounted byte-exact over
                # the digest-pinned container; never reformat them.
                "modules/nixos/vllm/overlays/**"
                # Package files vendored verbatim from nixpkgs.
                "overlays/pkgs/codex/**"
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
                # Prompt and skill files are model inputs; keep them verbatim
                # (mdformat also turns a skill's YAML front matter into a heading).
                mdformat.excludes = [
                  "**/prompts/**"
                  "**/skills/**"
                ];
              };
            };

            formatter = config.treefmt.build.wrapper;

            devShells.default = pkgs.mkShell {
              packages = [ config.treefmt.build.wrapper ];
              # Share the pre-push gate with every clone via tracked hooks.
              shellHook = "git config core.hooksPath .githooks";
            };
          };
      }
    );
}
