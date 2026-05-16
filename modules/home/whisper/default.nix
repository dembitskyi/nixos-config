{
  lib,
  config,
  pkgs,
  ...
}:
let
  whisperModel = pkgs.fetchurl {
    url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin";
    hash = "sha256-ZNGCtEC5jVIDxPm9VBVE2ExgUZbE97hF36EfsjWU0eI=";
  };

  whisperWithModel = pkgs.writeShellScriptBin "whisper" ''
    exec ${pkgs.whisper-cpp}/bin/whisper-cli \
      -m ${whisperModel} \
      "$@"
  '';
in
{
  options = {
    mine.home.whisper.enable = lib.mkEnableOption "enable whisper";
  };

  config = lib.mkIf config.mine.home.whisper.enable {
    home.packages = [
      whisperWithModel
      pkgs.whisper-cpp
    ];
    home.file.".local/share/whisper/models/ggml-large-v3.bin".source = whisperModel;
  };
}
