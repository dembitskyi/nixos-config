{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.home.nixvim-custom.enable = lib.mkEnableOption "enable nixvim-custom";
  };

  config = lib.mkIf config.mine.home.nixvim-custom.enable {
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
