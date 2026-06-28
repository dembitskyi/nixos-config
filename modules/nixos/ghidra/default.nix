{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.ghidra.enable = lib.mkEnableOption "enable ghidra";
  };

  config = lib.mkIf config.mine.ghidra.enable {
    programs.ghidra = {
      enable = true;
      gdb = true;
      package = pkgs.ghidra.withExtensions (
        p: with p; [
          findcrypt
          ret-sync
          #gnudisassembler
          sleighdevtools
          #wasm
          ghidra-firmware-utils
          ghidra-golanganalyzerextension
        ]
      );
    };
  };
}
