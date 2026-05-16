{
  lib,
  config,
  inputs,
  ...
}:
let
  extensions = [
    "${inputs.thunderbird-catppuccin}/themes/mocha/mocha-mauve.xpi"
  ];
in
{

  options = {
    mine.thunderbird.enable = lib.mkEnableOption "enable thunderbird (mail client)";
  };

  config = lib.mkIf config.mine.thunderbird.enable {
    programs.thunderbird = {
      enable = true;
      policies = {
        Extensions.Install = extensions;
      };
      preferences = {
        "privacy.donottrackheader.enabled" = true;
      };
    };
  };
}
