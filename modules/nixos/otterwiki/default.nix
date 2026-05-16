{
  lib,
  config,
  pkgs,
  inputs,
  ...
}:
let
  otterwikiEnv = pkgs.python3.withPackages (
    ps: with ps; [
      (toPythonModule pkgs.otterwiki)
      gunicorn
    ]
  );
  mkdocsEnv = pkgs.python3.withPackages (
    ps: with ps; [
      mkdocs-material
      pygments
    ]
  );
  repoRoot = "/var/lib/private/otterwiki-wiki";

  mkdocsDefault = {
    site_name = "My Library";
    site_description = "Documentation with Catppuccin theme";
    site_url = "https://example.com";
    #repo_url = "https://github.com/username/repo";
    #repo_name = "username/repo";

    theme = {
      name = "material";
      features = [
        "navigation.tabs"
        "navigation.sections"
        #"navigation.footer"
        "navigation.top"
        "navigation.tracking"
        "search.suggest"
        "search.highlight"
        "content.code.copy"
        "content.code.annotate"
      ];
      palette = [
        {
          scheme = "latte";
          primary = "custom";
          accent = "custom";
          toggle = {
            icon = "material/weather-sunny";
            name = "Switch to Frappé";
          };
        }
        {
          scheme = "frappe";
          primary = "custom";
          accent = "custom";
          toggle = {
            icon = "material/weather-night";
            name = "Switch to Macchiato";
          };
        }
      ];
    };
    extra_css = [ "css/extra.css" ];
    extra = {
      generator = false;
    };
    docs_dir = "${repoRoot}/mkdocsPrivate";
    nav = [
      { Home = "shared/index.md"; }
    ];
  };
in
{

  options = {
    mine.otterwiki.enable = lib.mkEnableOption "enable otterwiki";
    mine.otterwiki.mkdocsDefault = lib.mkOption {
      type = lib.types.attrs;
      default = mkdocsDefault;
    };
    mine.otterwiki.mkdocsYml = lib.mkOption {
      type = lib.types.path;
      default = (pkgs.formats.yaml { }).generate "mkdocs.yml" mkdocsDefault;
    };
  };

  config = lib.mkIf config.mine.otterwiki.enable {
    sops.secrets."wiki_env" = { };

    services.otterwiki.instances."wiki" = {
      settings = {
        SITE_NAME = "My wiki";
        READ_ACCESS = "ANONYMOUS";
        OTTERWIKI_SETTINGS = "/run/credentials/otterwiki-wiki.service/wiki_env";
        HIDE_LOGO = "True";
      };
      socket = {
        inherit (config.services.nginx) user group;
      };
      package = pkgs.otterwiki;
    };

    systemd.services.otterwiki-wiki.path = [
      pkgs.openssh
      pkgs.mkdocs
    ];
    systemd.services.otterwiki-wiki.serviceConfig.LoadCredential =
      "wiki_env:${config.sops.secrets.wiki_env.path}";

    networking.firewall.allowedTCPPorts = [ 6430 ];
    systemd.services.otterwiki-wiki.serviceConfig.ExecStart =
      lib.mkForce "${pkgs.writeShellScript "otterwiki-run" ''
        if [ ! -d "${repoRoot}/mkdocsPrivate" ] ; then
          mkdir ${repoRoot}/mkdocsPrivate ${repoRoot}/mkdocsPrivate/css
          ln -s ${repoRoot}/repository/shared ${repoRoot}/mkdocsPrivate/shared
          ln -s ${repoRoot}/repository/shared/index.md ${repoRoot}/mkdocsPrivate/index.md
          cp ${inputs.mkdocs-catppuccin}/docs/stylesheets/extra.css ${repoRoot}/mkdocsPrivate/css
        fi

        ${mkdocsEnv}/bin/mkdocs serve -f ${config.mine.otterwiki.mkdocsYml} --dev-addr 0.0.0.0:6430 &
        exec ${lib.getExe' otterwikiEnv "gunicorn"} --bind unix:${
          config.services.otterwiki.instances."wiki".socket.address
        } otterwiki.server:app
      ''}";

    services.nginx = {
      enable = true;
      virtualHosts."wiki.vmserver.vnet".locations."/" = {
        proxyPass = "http://unix:${config.services.otterwiki.instances."wiki".socket.address}";
      };
    };
  };
}
