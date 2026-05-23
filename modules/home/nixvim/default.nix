{
  lib,
  config,
  pkgs,
  nixvim-custom,
  ...
}:
let
  cfg = config.mine.home.nixvim-custom;
in
{

  imports = [ nixvim-custom.homeModules.default ];

  options.mine.home.nixvim-custom = {
    enable = lib.mkEnableOption "enable nixvim-custom";
    profile = lib.mkOption {
      type = lib.types.enum [
        "home"
        "work"
      ];
      default = "home";
      description = "Which nvim.nix profile to install (home uses local LLM, work uses Copilot).";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.nvim-nix = {
      enable = true;
      inherit (cfg) profile;
    };

    home.packages = with pkgs; [
      prettierd
      gh
      google-java-format
      # formatters
      python3Packages.black
      python3Packages.isort
      pkgs.prettier
      # linters
      alejandra
      deadnix
      nixpkgs-fmt
      stylua
      statix
      yamlfmt
      cpplint
      eslint_d
      # media
      viu
      chafa
      # tools
      lsof
      tree-sitter
      (pkgs.python313.withPackages (
        ps: with ps; [
          flake8
          demjson3
        ]
      ))
    ];
  };
}
