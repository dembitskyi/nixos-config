{
  lib,
  config,
  ...
}:
{

  options = {
    mine.home.bash.enable = lib.mkEnableOption "enable bash configs";
  };

  config = lib.mkIf config.mine.home.bash.enable {
    programs.bash = {
      enable = true;
      enableCompletion = true;
      historyControl = [ "erasedups" ];
      historyFileSize = -1;
      historySize = -1;
      bashrcExtra = ''
        export PATH="$PATH:$HOME/bin:$HOME/.local/bin:$HOME/go/bin"
        export PROMPT_COMMAND='history -a; history -c; history -r'
      '';
      shellAliases = {
        fo = "f=\$(fzf); [ -n \"\$f\" ] && \${EDITOR:-nvim} \"$f\"";
        journald-clear = "sudo journalctl --rotate && sudo journalctl --vacuum-time=1s";
        clear-cb = "cliphist wipe";
        gc-all = "sudo nix-collect-garbage -d";
      };
    };
  };
}
