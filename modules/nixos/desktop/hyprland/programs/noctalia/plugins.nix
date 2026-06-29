{ pkgs, ncInputs, ... }:

{
  home.file.".config/noctalia/plugins" = {
    source = pkgs.runCommand "noctalia-plugins-custom" { } ''
      cp -r --no-preserve=mode ${ncInputs.noctalia-plugins} $out
      cp -r ${./corner-alert} $out/corner-alert
    '';
  };

  home.file.".config/noctalia/plugins.json" = {
    text = builtins.toJSON {
      sources = [
        {
          enabled = true;
          name = "Official Noctalia Plugins";
          url = "https://github.com/noctalia-dev/noctalia-plugins";
        }
      ];
      states = {
        corner-alert = {
          enabled = true;
        };
      };
    };
  };
}
