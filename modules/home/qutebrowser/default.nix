{
  lib,
  config,
  pkgs,
  variables,
  inputs,
  ...
}:
{

  options = {
    mine.home.qutebrowser.enable = lib.mkEnableOption "enable qutebrowser";
    mine.home.qutebrowser.bookmarks = lib.mkOption {
      type = lib.types.lines;
      default = ''
        https://mail.google.com/ gmail
        https://searchmysite.net/ searchmysite
      '';
      description = "Lines for qutebrowser bookmarks/urls";
    };

    mine.home.qutebrowser.searchEngines =
      with lib;
      mkOption {
        type = types.attrs;
        default = {
          DEFAULT = "https://www.google.com/search?q={}";
          duck = "https://duckduckgo.com/?q={}";
          hm = "https://home-manager-options.extranix.com/?query={}&release=master";
          nm = "https://nixos.org/manual/nix/stable/introduction.html?search={}";
          np = "https://search.nixos.org/packages?query={}";
          stack = "https://stackexchange.com/search?q={}";
          we = "https://en.wikipedia.org/wiki/{}";
          yt = "https://www.youtube.com/results?search_query={}";
          gh = "https://github.com/search?q={}&type=code";
          g = "https://www.google.com/search?q={}";
          p = "https://www.perplexity.ai/?q={}";
        };
        description = "Browser search engines.";
        readOnly = true;
      };
  };

  config = lib.mkIf config.mine.home.qutebrowser.enable {
    xdg.configFile."qutebrowser/bookmarks/urls".text = config.mine.home.qutebrowser.bookmarks;
    home.file.".local/share/qutebrowser/qtwebengine_dictionaries/en-US-10-1.bdic".source =
      pkgs.hunspellDictsChromium.en_US;

    home.file.".config/qutebrowser/userscripts".source = ./scripts;
    home.file.".config/qutebrowser/catppuccin".source = inputs.catppuccin-qutebrowser;

    programs = {
      qutebrowser = {
        enable = true;
        package = pkgs.qutebrowser.override {
          withPdfReader = true;
          enableWideVine = variables.qb-enableWideVine;
        };
        searchEngines = config.mine.home.qutebrowser.searchEngines;
        loadAutoconfig = true;
        settings.spellcheck.languages = [ "en-US" ];

        greasemonkey = [
          # keep-sorted start
          pkgs.greasemonkeyUserscripts.always-on-focus
          pkgs.greasemonkeyUserscripts.anchor-links
          pkgs.greasemonkeyUserscripts.bandcamp-extended-album-history
          pkgs.greasemonkeyUserscripts.bandcamp-volume-bar
          pkgs.greasemonkeyUserscripts.better-osm-org
          pkgs.greasemonkeyUserscripts.betterttv
          pkgs.greasemonkeyUserscripts.collapse-hackernews-parent-comments
          pkgs.greasemonkeyUserscripts.ctrl-enter-is-submit-everywhere
          pkgs.greasemonkeyUserscripts.fastmail-without-bevels
          pkgs.greasemonkeyUserscripts.fb-clean-my-feeds
          pkgs.greasemonkeyUserscripts.hacker-news-date-tooltips
          pkgs.greasemonkeyUserscripts.hacker-news-highlighter
          pkgs.greasemonkeyUserscripts.imdb-full-summary
          pkgs.greasemonkeyUserscripts.instagram-video-controls
          pkgs.greasemonkeyUserscripts.lobsters-highlighter
          pkgs.greasemonkeyUserscripts.lobsters-open-in-new-tab
          pkgs.greasemonkeyUserscripts.quirks
          pkgs.greasemonkeyUserscripts.recaptcha-unpaid-labor
          pkgs.greasemonkeyUserscripts.reddit-comment-auto-expander
          pkgs.greasemonkeyUserscripts.reddit-highlighter
          pkgs.greasemonkeyUserscripts.rewrite-smolweb
          pkgs.greasemonkeyUserscripts.select-text-inside-a-link-like-opera
          pkgs.greasemonkeyUserscripts.show-password-onmouseover
          pkgs.greasemonkeyUserscripts.speed-up-google-captcha
          pkgs.greasemonkeyUserscripts.substack-popup-dismisser
          pkgs.greasemonkeyUserscripts.twitter-direct
          pkgs.greasemonkeyUserscripts.video-quality-fixer-for-twitter
          pkgs.greasemonkeyUserscripts.video-swap-new
          pkgs.greasemonkeyUserscripts.youtube-autoskip
        ];
        extraConfig = ''
          import catppuccin

          config.load_autoconfig()

          c.url.start_pages = [ "www.google.com" ]
          c.hints.chars = "aoeuhtns"

          c.downloads.location.directory = '~/Downloads'
          c.downloads.location.prompt = True
          c.downloads.position = 'bottom'

          c.hints.radius = 6
          c.hints.padding = {"bottom": 4, "left": 4, "right": 4, "top": 4}
          c.content.headers.do_not_track = True
          c.content.headers.user_agent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
          c.content.headers.custom = {
            "Sec-Ch-Ua": "\"Not:A-Brand\";v=\"24\", \"Chromium\";v=\"147\"",
            "Sec-Ch-Ua-Full-Version": "147.0.7727.117",
            "Sec-Ch-Ua-Full-Version-List": "\"Not:A-Brand\";v=\"24.0.0.0\", \"Chromium\";v=\"147.0.7727.117\""
          }

          catppuccin.setup(c, "mocha", True)
          c.colors.completion.match.fg = "#a6e3a1"
        '';
      };
    };
  };
}
