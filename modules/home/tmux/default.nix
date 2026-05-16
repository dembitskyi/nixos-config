{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.home.tmux.enable = lib.mkEnableOption "enable tmux";
  };

  config = lib.mkIf config.mine.home.tmux.enable {
    programs.tmux = {
      enable = true;
      tmuxp.enable = true;
      historyLimit = 1000000;
      terminal = "tmux-256color";
      secureSocket = false;
      clock24 = true;
      baseIndex = 1;
      keyMode = "vi";
      mouse = true;
      plugins = with pkgs; [
        {
          plugin = tmuxPlugins.yank;
          extraConfig = ''
            set-option -g status-keys emacs

            # copy-mode
            bind P paste-buffer
            bind-key -T copy-mode-vi v send-keys -X begin-selection
            bind-key -T copy-mode-vi y send-keys -X rectangle-toggle
            unbind-key -T copy-mode-vi Enter

            set -g status-position top
            set-option -g status-right ""
            set-option -g  status-left '#[bg=gray,fg=black] #{session_name} '
            set-option -wg window-status-current-format '#[bg=cyan,fg=black] #{window_index} #{window_name} #{window_flags}'
            set-option -wg window-status-format '#[bg=brightblack,fg=white] #{window_index} #{window_name} #{window_flags}'

            bind C-v split-window -h -c "#{pane_current_path}"
            bind C-s split-window -v -c "#{pane_current_path}"
            bind C-l clear-history

            set-option -g  @yank_action copy-pipe
            set-option -g set-clipboard on
          '';
        }
        {
          plugin = tmuxPlugins.jump;
          extraConfig = "set-option -g  @jump-key s";
        }
        {
          plugin = tmuxPlugins.nord;
          extraConfig = "set-option -g  @nord_tmux_show_status_content 0";
        }
        {
          plugin = tmuxPlugins.better-mouse-mode;
          extraConfig = "set-option -g  @scroll-down-exit-copy-mode off";
        }
        tmuxPlugins.weather
        tmuxPlugins.fuzzback
      ];
    };
  };
}
