{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.home.nixvim-custom;
in
{

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
    minuet.enable = lib.mkOption {
      type = lib.types.bool;
      default = cfg.profile == "home";
      description = "Enable the minuet AI (local LLM via vLLM) completion source. Defaults on for the home profile; set false to keep the home profile without the local LLM completion.";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.nvim-nix = {
      enable = true;
      inherit (cfg) profile;
      ai.minuet.enable = cfg.minuet.enable;
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
